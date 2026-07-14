//
// probe-surface-locked-while-mutating
//
// The goal, exactly — no more, no less: while the agent is mutating a region,
// the harness disables ONLY that region (what is being mutated). A checkbox that
// lives in the region goes inert; a checkbox elsewhere in the same component,
// unrelated to what the agent is touching, stays fully live. When the agent
// stops, the region frees itself.
//
// The observable is each checkbox's own checked state (what a user sees). The
// test agent holds a stream open into #stream-target for a few seconds (a
// stand-in for a slow edit).
//
//   1. While the agent's stream is open (Stop showing): clicking the INSIDE
//      checkbox does nothing (it's inert), while clicking the OUTSIDE checkbox
//      checks it. Locked what's mutated; left the unrelated control alone.
//   2. Agent finishes (Stop gone): the inside checkbox checks — the region freed.
//
// Broken-build failure modes this catches: no lock (inside checks mid-stream);
// over-lock of the whole surface (outside can't check mid-stream); stranded lock
// (inside never checks after the agent finishes).
//
// Run it:  node run-probe.mjs probe-surface-locked-while-mutating
//

export const fixture = './workspace.liquidos';
export const agent = './agent.js';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const inside = page.getByRole('checkbox', { name: 'inside marker' });
    const outside = page.getByRole('checkbox', { name: 'outside marker' });
    const startButton = page.getByRole('button', { name: 'Start' });
    const stopButton = page.getByRole('button', { name: 'Stop' });

    await inside.waitFor({ state: 'visible', timeout: 20000 });

    // Start the agent's mutation and wait for it in flight (Stop shows).
    await startButton.click();
    await stopButton.waitFor({ state: 'visible', timeout: 10000 })
        .catch(() => { throw new Error('agent job never went in flight (Stop button never appeared)'); });
    await page.waitForTimeout(1000); // let the stream open
    console.log('agent mutating #stream-target');

    // The inside checkbox (in the mutated region) must be inert — a click does
    // not check it...
    await inside.click({ timeout: 1500 }).catch(() => {});
    if (await inside.isChecked()) {
        throw new Error('the inside checkbox toggled while its region was being mutated — the region was not disabled');
    }
    // ...and the outside checkbox (unrelated) must still check — no over-lock.
    await outside.click({ timeout: 4000 })
        .catch(() => { throw new Error('the outside checkbox would not toggle during the mutation — the lock spread beyond the mutated region'); });
    if (!(await outside.isChecked())) {
        throw new Error('the outside checkbox did not check during the mutation — the lock spread beyond the mutated region');
    }
    console.log('mutating: inside stayed unchecked (locked), outside checked (untouched)');

    // Agent finishes → the region frees itself → the inside checkbox checks.
    await stopButton.waitFor({ state: 'hidden', timeout: 20000 })
        .catch(() => { throw new Error('agent never finished (Stop button stayed up)'); });
    await inside.click({ timeout: 5000 });
    await page.waitForFunction(
        () => document.querySelector('input[aria-label="inside marker"]')?.checked === true,
        null, { timeout: 5000 }
    ).catch(() => { throw new Error('the inside checkbox did not check after the agent finished — the region never freed'); });
    console.log('after: inside checks — region freed itself');
};
