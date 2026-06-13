//
// probe-canvas-switcher.mjs
//
// Open canvas-info on the active canvas (home) → the modal shows home's
// feature-requirements.txt. Close. Switch to the "other" canvas via the
// dropdown. Open canvas-info again → the modal shows other's
// feature-requirements.txt (not stale home content). Verifies the
// per-canvas content isolation through the user-facing switcher flow.
//
// Run it:  node run-probe.mjs probe-canvas-switcher.mjs
//

export const fixture = 'canvas-switcher.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#canvas-select', { timeout: 20000 });
    await sleep(1500);

    // 1. Open canvas-info on home; assert HOME marker.
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const ta = document.getElementById('canvas-requirements-textarea');
            return ta && ta.value && ta.value.includes('HOME_CANVAS_MARKER');
        },
        { timeout: 5000 }
    );
    const homeText = (await page.locator('#canvas-requirements-textarea').inputValue()).trim();
    console.log('home modal:', homeText);
    await page.locator('#canvas-requirements-cancel').dispatchEvent('click');
    await sleep(300);

    // 2. Switch to "other" via the dropdown.
    await page.locator('#canvas-select').selectOption('other');
    await page.waitForFunction(
        () => document.getElementById('canvas-select').value === 'other',
        { timeout: 5000 }
    );
    await sleep(500);

    // 3. Open canvas-info; assert OTHER marker, NOT HOME's content.
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const ta = document.getElementById('canvas-requirements-textarea');
            return ta && ta.value && ta.value.includes('OTHER_CANVAS_MARKER');
        },
        { timeout: 5000 }
    );
    const otherText = (await page.locator('#canvas-requirements-textarea').inputValue()).trim();
    console.log('other modal:', otherText);
    if (otherText.includes('HOME_CANVAS_MARKER')) {
        throw new Error('other-canvas modal showed home content');
    }
};
