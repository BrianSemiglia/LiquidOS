//
// probe-canvas-damaged-repair-click.mjs
//
// Clicking the Repair button on a "Canvas is damaged" card dispatches
// the agent scoped to the canvas. The stub agent rewrites index.json
// to point at a pre-staged repaired component (carrying a known DOM
// marker). The probe asserts the marker appears — proof that the
// Repair click actually drove the canvas back to a healthy state.
//
// Run it:  node run-probe.mjs probe-canvas-damaged-repair-click.mjs
//

export const fixture = './probe-canvas-damaged-repair-click.liquidos';
export const agent = 'canvas-damaged-repair-test';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the "Canvas is damaged" Repair card and click its button.
    // The card itself is the role="group" wrapper — narrowing on that
    // avoids the unrelated hidden chrome Repair button on the same item.
    const repair = page.locator('[role="group"][data-repair-level="canvas"] button', { hasText: 'Repair' }).first();
    await repair.waitFor({ state: 'visible', timeout: 10000 });
    await repair.click();

    // Agent dispatches → either the success marker appears, or the
    // failure marker surfaces the actual prompt the agent received.
    await page.waitForFunction(
        () => document.querySelector('[data-canvas-repair-marker]')
            || document.querySelector('[data-canvas-repair-failure]'),
        { timeout: 10000 }
    );
    const failure = await page.evaluate(() => {
        const el = document.querySelector('[data-canvas-repair-failure]');
        if (!el) return null;
        return {
            reason: el.querySelector('p')?.textContent || '(no reason)',
            promptReceived: el.querySelector('[data-prompt-received]')?.textContent || '(empty)'
        };
    });
    if (failure) {
        console.error('--- prompt the agent received ---');
        console.error(failure.promptReceived);
        console.error('---');
        throw new Error(failure.reason);
    }
};
