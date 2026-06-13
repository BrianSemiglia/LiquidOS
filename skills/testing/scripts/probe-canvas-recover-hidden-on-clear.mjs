//
// probe-canvas-recover-hidden-on-clear.mjs
//
// Companion to probe-canvas-generate-gates. The fixture has a
// populated feature-requirements.txt and zero components. When the
// user opens the modal and deletes all the text, the textarea ends up
// empty — but there are still no components to write about, so the
// Generate/Repair callback must stay hidden. The gate fires on
// "textarea empty AND zero components", independent of whether the
// file's loaded outcome was 'empty' or 'present'.
//
// Run it:  node run-probe.mjs probe-canvas-recover-hidden-on-clear.mjs
//

export const fixture = 'canvas-with-reqs-no-components.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.locator('#canvas-info').click();
    await page.waitForSelector('#canvas-requirements-overlay:not([hidden])', { timeout: 5000 });
    // File loaded with content — wait for the textarea to show it.
    await page.waitForFunction(
        () => document.getElementById('canvas-requirements-textarea')?.value?.includes('Existing requirements'),
        { timeout: 5000 }
    );

    // Clear it.
    await page.locator('#canvas-requirements-textarea').fill('');

    // Recover callback must stay hidden — zero components, nothing to write.
    await sleep(300);
    const visible = await page.evaluate(() => {
        const cb = document.getElementById('canvas-requirements-recover-callback');
        return !!cb && !cb.hidden;
    });
    if (visible) {
        throw new Error('recover callback visible after the user cleared the textarea on a zero-component canvas');
    }
};
