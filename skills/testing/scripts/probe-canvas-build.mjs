//
// probe-canvas-build.mjs
//
// User edits feature-requirements.txt + clicks Build → /canvas/requirements
// writes the file and dispatches the agent → test agent adds the
// pre-staged probe-built component to index.json → harness re-renders
// with the new component → probe observes the [data-canvas-build-marker]
// element in the DOM.
//
// Run it:  node run-probe.mjs probe-canvas-build.mjs
//

export const fixture = './probe-canvas-build.liquidos';
export const agent = 'agent/test/canvas-build-test-agent.js';

const MARKER = 'PROBE_CANVAS_BUILD';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    // Pre-condition: no probe-built marker visible yet.
    if (await page.locator('[data-canvas-build-marker]').count() !== 0) {
        throw new Error('marker existed before Build');
    }

    // Open the canvas requirements modal.
    await page.locator('#canvas-reqs-toggle').dispatchEvent('click');
    await page.waitForSelector('#canvas-requirements-textarea', { state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => !document.getElementById('canvas-requirements-textarea').disabled, { timeout: 5000 });
    await page.locator('#canvas-requirements-textarea').fill('- ' + MARKER + '\n');
    await page.locator('#canvas-requirements-save').dispatchEvent('click');

    // The harness's input watcher re-renders the canvas after the agent
    // writes index.json; wait for the new component's marker to appear.
    try {
        await page.waitForSelector('[data-canvas-build-marker]', { timeout: 10000 });
        const markerText = (await page.locator('[data-canvas-build-marker]').textContent() || '').trim();
        console.log('observed marker:', markerText);
        if (markerText !== 'BUILT') {
            throw new Error('marker text was not "BUILT"');
        }
    } catch (e) {
        if (e.message === 'marker text was not "BUILT"') throw e;
        throw new Error('probe-built component never surfaced in the DOM');
    }
};
