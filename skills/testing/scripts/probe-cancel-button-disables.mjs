//
// probe-cancel-button-disables.mjs
//
// The ✕ is disabled exactly while the job it submitted (the undo) is queued or
// running, so a second click can't queue a second undo and it doesn't flicker
// back to enabled while the undo is still in flight. It re-enables only once
// that job leaves the queue (here, by the queue draining and the button hiding).
//
// Scenario: submit a job that starts work ("BUILT") and hangs. While it runs
// the ✕ is shown and enabled. Clicking it queues the cancel — at that instant
// the button must be disabled, and it must remain disabled (never visibly
// enabled again) right up until it hides. The cancel still goes through ("BUILT"
// leaves the screen via the undo).
//
// We LISTEN for the button's state transitions with a MutationObserver (not a
// poll loop), recording every (disabled, hidden) pair, then assert none was
// "visible and enabled" after the click. `disabled` is the exact interactive
// state under test (a person sees a dimmed, unclickable button), not internal
// structure.
//
// Run it:  node run-probe.mjs probe-cancel-button-disables.mjs
//

export const fixture = 'canvas-build.liquidos';
export const agent = 'prompt-cancel-test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#global-text', { timeout: 20000 });
    await sleep(1500);

    // Start the work; the agent shows "BUILT" then hangs.
    await page.evaluate(() => {
        document.getElementById('global-text').value = 'Build the thing.';
        document.getElementById('global-prompt').requestSubmit();
    });
    await page.getByText('BUILT', { exact: true }).waitFor({ timeout: 10000 });

    // While the job runs, the ✕ is shown and still clickable.
    const stop = page.getByRole('button', { name: 'Stop' });
    await stop.waitFor({ timeout: 5000 });
    if (await stop.isDisabled()) {
        throw new Error('the ✕ was disabled before any cancellation was queued');
    }

    // Start listening to the ✕'s disabled/hidden transitions before clicking.
    await page.evaluate(() => {
        const button = document.getElementById('global-cancel');
        window.__cancelStates = [];
        window.__cancelObserver = new MutationObserver(() => {
            window.__cancelStates.push({ disabled: button.disabled, hidden: button.hidden });
        });
        window.__cancelObserver.observe(button, { attributes: true, attributeFilter: ['disabled', 'hidden'] });
    });

    // Click it and read the disabled state in the same tick — it must disable
    // the instant the cancellation is queued.
    const disabledRightAfterClick = await page.evaluate(() => {
        const button = document.getElementById('global-cancel');
        button.click();
        return button.disabled;
    });
    if (!disabledRightAfterClick) {
        throw new Error('the ✕ stayed enabled after the cancellation was queued');
    }

    // The cancellation runs: the started work is undone and, once the queue
    // drains, the ✕ goes away.
    await page.getByText('BUILT', { exact: true }).waitFor({ state: 'detached', timeout: 10000 });
    await stop.waitFor({ state: 'hidden', timeout: 10000 });

    // Every transition was recorded by listening — none may be "visible AND
    // enabled", which would mean it re-enabled mid-cancel.
    const reEnabledWhileVisible = await page.evaluate(() =>
        window.__cancelStates.some(s => s.disabled === false && s.hidden === false));
    if (reEnabledWhileVisible) {
        throw new Error('the ✕ re-enabled while the job it submitted was still in flight');
    }
};
