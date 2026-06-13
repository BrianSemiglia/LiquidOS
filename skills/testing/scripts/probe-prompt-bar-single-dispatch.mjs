//
// probe-prompt-bar-single-dispatch.mjs
//
// User types into the prompt bar and submits once. The agent must be
// invoked exactly once. The stub agent writes a "dispatched once"
// marker on the first call and a "dispatched twice" marker on any
// subsequent call. Probe asserts the once-marker appears AND the
// twice-marker never does — proof that one user submit produces one
// dispatch.
//
// Run it:  node run-probe.mjs probe-prompt-bar-single-dispatch.mjs
//

export const fixture = 'prompt-bar-single-dispatch.liquidos';
export const agent = 'prompt-bar-single-dispatch-test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-counter-initial]', { timeout: 20000 });

    // Type a prompt and submit once via the Send button.
    await page.locator('#global-text').fill('probe single-dispatch');
    await page.locator('#global-prompt button[type="submit"]').click();

    // First marker arrives — that's the healthy path.
    await page.waitForSelector('[data-dispatched-once]', { timeout: 10000 });

    // Then wait long enough that any second auto-dispatch would have
    // completed and overwritten the view with the twice-marker.
    await sleep(2000);
    const doubled = await page.locator('[data-dispatched-twice]').count();
    if (doubled > 0) {
        const text = await page.locator('[data-dispatched-twice]').textContent();
        throw new Error(text);
    }
};
