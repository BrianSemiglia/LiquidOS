//
// probe-callback-dispatch.mjs
//
// User clicks a <liquidos-callback>-wrapped button → harness dispatches
// the agent → agent rewrites the component's view.json with a PONG
// marker → harness file watcher picks up the change and re-renders →
// probe observes the new DOM.
//
// Verification is purely UI: we read the DOM after the dispatch round-
// trip and assert the span content. No filesystem inspection.
//
// Run it:  node run-probe.mjs probe-callback-dispatch.mjs
//

export const fixture = './probe-callback-dispatch.liquidos';
export const agent = 'callback-dispatch-test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-probe-btn]', { timeout: 20000 });
    await sleep(1500);

    // Pre-condition: the PONG span doesn't exist yet.
    const pongBefore = await page.locator('[data-pong]').count();
    if (pongBefore !== 0) {
        throw new Error('probe-pong span existed before the callback fired');
    }

    await page.locator('[data-probe-btn]').dispatchEvent('click');

    // The harness's file watcher reflects view.json edits in the DOM;
    // wait for the PONG span the agent wrote to materialize.
    try {
        await page.waitForSelector('[data-pong]', { timeout: 8000 });
        const pongText = (await page.locator('[data-pong]').textContent() || '').trim();
        console.log('observed pong text:', pongText);
        if (pongText !== 'PONG') {
            throw new Error('pong span did not contain PONG');
        }
    } catch (e) {
        if (e.message === 'pong span did not contain PONG') throw e;
        throw new Error('pong span never surfaced — dispatch did not complete the round trip');
    }
};
