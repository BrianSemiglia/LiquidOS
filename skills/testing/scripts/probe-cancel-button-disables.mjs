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
// poll loop), recording every (enabled, visible) pair, then assert none was
// "visible and enabled" after the click. Disabled is the exact interactive
// state under test — a person sees a dimmed, unclickable button — read the
// accessible way: the ✕ located by its role + name, its :disabled state and
// real visibility, never an internal flag reached by id.
//
// Run it:  node run-probe.mjs probe-cancel-button-disables.mjs
//

export const fixture = './probe-cancel-button-disables.liquidos';
export const agent = 'agent/test/cancel-button-disables-agent.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const promptBar = (page) => page.getByRole('textbox', { name: 'Prompt' });

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await promptBar(page).waitFor({ timeout: 20000 });
    await sleep(1500);

    // Start the work; the agent shows "BUILT" then hangs.
    await promptBar(page).fill('Build the thing.');
    await promptBar(page).press('Enter');
    await page.getByText('BUILT', { exact: true }).waitFor({ timeout: 10000 });

    // While the job runs, the ✕ is shown and still clickable.
    const stop = page.getByRole('button', { name: 'Stop' });
    await stop.waitFor({ timeout: 5000 });
    if (await stop.isDisabled()) {
        throw new Error('the ✕ was disabled before any cancellation was queued');
    }

    // Start listening to the ✕'s enabled/visible transitions before clicking.
    // The element is the one located by role + name above; read its accessible
    // interactive state (:disabled) and real visibility, not raw flags.
    const stopEl = await stop.elementHandle();
    await page.evaluate((button) => {
        window.__cancelStates = [];
        const snapshot = () => ({ enabled: !button.matches(':disabled'), visible: button.checkVisibility() });
        window.__cancelObserver = new MutationObserver(() => window.__cancelStates.push(snapshot()));
        window.__cancelObserver.observe(button, { attributes: true });
    }, stopEl);

    // Click it and read the disabled state in the same tick — it must disable
    // the instant the cancellation is queued.
    const disabledRightAfterClick = await page.evaluate((button) => {
        button.click();
        return button.matches(':disabled');
    }, stopEl);
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
        window.__cancelStates.some(s => s.enabled && s.visible));
    if (reEnabledWhileVisible) {
        throw new Error('the ✕ re-enabled while the job it submitted was still in flight');
    }
};
