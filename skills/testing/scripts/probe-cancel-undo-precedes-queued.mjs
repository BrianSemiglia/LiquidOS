//
// probe-cancel-undo-precedes-queued.mjs
//
// When the user cancels a running job that has another job queued behind it,
// the cancel's cleanup (undo) must run BEFORE the queued job — otherwise the
// queued job runs against the canceled job's half-finished state.
//
// Scenario:
//   - Submit "Build the thing." (R): the agent adds the probe-built component
//     ("BUILT" shows) and hangs on a live process — a job mid-flight.
//   - Submit "Queue a marker." (Q) while R runs: it queues behind R. When it
//     eventually runs it reconciles the canvas to a distinct "QUEUED" marker.
//   - Click Stop: the server kills R and enqueues the undo, which blindly
//     resets the canvas to empty.
//
// The undo wiping the canvas to empty is the discriminator: it must land
// before Q. If the undo runs first (correct), it clears R's "BUILT", then Q
// places "QUEUED" — so "QUEUED" is the settled end state. If the undo were
// appended behind Q (the old bug), Q places "QUEUED" and then the undo wipes
// it — so nothing survives. We assert on the state after the queue drains
// (the Stop button is gone), so a transient flash can't fool the check.
//
// Run it:  node run-probe.mjs probe-cancel-undo-precedes-queued.mjs
//

export const fixture = './probe-cancel-undo-precedes-queued.liquidos';
export const agent = 'cancel-undo-precedes-queued';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Set the value and submit programmatically rather than typing: the second
// submit happens while the first job is in flight, when the prompt bar is
// `inert` (not editable), so locator.fill() can't reach it. requestSubmit
// still dispatches the callback through the inert wrapper.
const submitPrompt = (page, text) =>
    page.evaluate((value) => {
        document.getElementById('global-text').value = value;
        document.getElementById('global-prompt').requestSubmit();
    }, text);

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#global-text', { timeout: 20000 });
    await sleep(1500);

    if (await page.getByText('BUILT', { exact: true }).count() !== 0) {
        throw new Error('"BUILT" was on screen before the prompt submit');
    }
    if (await page.getByText('QUEUED', { exact: true }).count() !== 0) {
        throw new Error('"QUEUED" was on screen before the prompt submit');
    }

    // R: starts the work and hangs.
    await submitPrompt(page, 'Build the thing.');
    await page.getByText('BUILT', { exact: true }).waitFor({ timeout: 10000 });

    // Q: queued behind the still-running R. (programmatic submit dispatches the
    // callback even though the prompt bar is inert while a job is in flight.)
    await submitPrompt(page, 'Queue a marker.');

    // Cancel R: the server kills it and enqueues the undo ahead of Q.
    await page.getByRole('button', { name: 'Stop' }).click({ timeout: 5000 });

    // Q runs at some point regardless of order, so "QUEUED" appears in both the
    // correct and the buggy ordering — wait for it, then wait for the queue to
    // fully drain (Stop button gone). Only then is the canvas at its settled
    // end state.
    await page.getByText('QUEUED', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'hidden', timeout: 10000 });

    // Settled: "QUEUED" survives only if the undo ran before Q. If the undo had
    // been queued behind Q, it would have wiped "QUEUED" off the canvas.
    if (await page.getByText('QUEUED', { exact: true }).count() === 0) {
        throw new Error('the undo ran after the queued job and wiped "QUEUED" — cleanup was not inserted ahead of the queue');
    }
    if (await page.getByText('BUILT', { exact: true }).count() !== 0) {
        throw new Error('"BUILT" survived — the cancel did not undo the canceled job\'s work');
    }
};
