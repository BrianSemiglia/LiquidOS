//
// probe-canvas-create.mjs
//
// User zooms out to the grid → clicks "+ New" → Browse overlay opens →
// clicks the "from scratch" tile → name modal opens → types a name +
// submits → the canvas grid updates with the new canvas. UI-only; no
// agent involved.
//
// Run it:  node run-probe.mjs probe-canvas-create.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = 'canvas-build.liquidos';

const NAME = 'probe-created-canvas';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#canvas-overview-toggle', { timeout: 20000 });
    await sleep(1500);

    // Pre-condition: the canvas grid doesn't list NAME yet.
    const before = await page.locator('.canvas-grid-card[data-canvas]').evaluateAll(els => els.map(e => e.dataset.canvas));
    console.log('canvases before:', before);
    if (before.some(t => t.trim() === NAME)) {
        throw new Error('canvas already existed before create');
    }

    // Server-startup bootstrap (ensureCanvasDefaults on 'home') must not
    // materialize an empty feature-requirements.txt for an already-existing
    // canvas. The file is the user's signal that they've expressed canvas
    // intent; the harness creating it pre-emptively would mask the missing-
    // vs-empty distinction the Repair/Generate UI relies on.
    const homeFeatureFile = path.join(workspace, 'home', 'feature-requirements.txt');
    if (fs.existsSync(homeFeatureFile)) {
        throw new Error('server startup created home/feature-requirements.txt; bootstrap should leave existing canvases alone');
    }

    // Grid "+ New" → opens Browse overlay (grid stays underneath).
    await page.locator('#canvas-overview-toggle').dispatchEvent('click');
    await page.locator('#canvas-grid-new').dispatchEvent('click');
    await page.waitForSelector('#browse-overlay:not([hidden])', { timeout: 5000 });
    // From-scratch tile → opens the name modal (browse stays underneath).
    await page.locator('#browse-from-scratch').dispatchEvent('click');
    await page.waitForSelector('#new-canvas-backdrop:not([hidden])', { timeout: 5000 });
    // Type name + submit.
    await page.locator('#new-canvas-name').fill(NAME);
    await page.evaluate(() => document.getElementById('new-canvas-modal').requestSubmit());

    // Wait for the canvas grid to surface the new canvas.
    await page.waitForFunction(
        (target) => Array.from(document.querySelectorAll('.canvas-grid-card[data-canvas]')).some(c => c.dataset.canvas === target),
        NAME,
        { timeout: 10000 }
    );
    const after = await page.locator('.canvas-grid-card[data-canvas]').evaluateAll(els => els.map(e => e.dataset.canvas));
    console.log('canvases after :', after);

    // Canvas-creation IS the moment feature-requirements.txt gets materialized
    // (empty by default; user/agent fills it in). Verify the new canvas has it.
    const newFeatureFile = path.join(workspace, NAME, 'feature-requirements.txt');
    if (!fs.existsSync(newFeatureFile)) {
        throw new Error('canvas creation did not materialize feature-requirements.txt');
    } else {
        const size = fs.statSync(newFeatureFile).size;
        console.log('new canvas feature-requirements.txt size:', size);
        if (size !== 0) {
            throw new Error('new canvas feature-requirements.txt should start empty, got size ' + size);
        }
    }
};
