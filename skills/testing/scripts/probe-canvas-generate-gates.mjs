//
// probe-canvas-generate-gates.mjs
//
// The Generate button on the canvas requirements modal should only
// surface when ALL three are true:
//   1. The feature-requirements.txt file exists.
//   2. It is empty.
//   3. The canvas has at least one component.
//
// This probe exercises the third gate: the fixture has no components
// and an empty feature-requirements.txt. The Generate button must
// stay hidden.
//
// Run it:  node run-probe.mjs probe-canvas-generate-gates.mjs
//

export const fixture = 'canvas-empty-no-components.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.locator('#canvas-info').click();
    await page.waitForSelector('#canvas-requirements-overlay:not([hidden])', { timeout: 5000 });
    // Give openCanvasRequirements time to fetch + decide.
    await sleep(500);

    const visible = await page.evaluate(() => {
        const cb = document.getElementById('canvas-requirements-recover-callback');
        return !!cb && !cb.hidden;
    });
    if (visible) {
        throw new Error('Generate/Repair callback visible despite canvas having zero components');
    }
};
