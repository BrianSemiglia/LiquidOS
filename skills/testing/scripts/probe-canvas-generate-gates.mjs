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
// and an empty feature-requirements.txt. Neither "Generate" nor
// "Repair" must appear on screen after the modal opens.
//
// Run it:  node run-probe.mjs probe-canvas-generate-gates.mjs
//

export const fixture = 'canvas-empty-no-components.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.locator('#canvas-info').click();
    // Give openCanvasRequirements time to fetch + decide.
    await sleep(500);

    // Neither "Generate" nor "Repair" should be visible — the gate blocks
    // the recover callback when there are zero components.
    const text = await page.evaluate(() => document.body.innerText);
    if (text.includes('Generate')) {
        throw new Error('"Generate" is visible despite the canvas having zero components');
    }
    if (text.includes('Repair')) {
        throw new Error('"Repair" is visible despite the canvas having zero components');
    }
};
