//
// probe-canvas-damaged.mjs
//
// A malformed index.json on the active canvas surfaces a "Repair" button
// the user can see. The probe writes a bad index.json into the sandbox
// after boot (so the harness sees the change), then asserts on what
// appears on screen.
//
// Run it:  node run-probe.mjs probe-canvas-damaged.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = 'canvas-build.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    const onScreen = (text) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout: 8000 });
    const offScreen = (text) => page.waitForFunction(
        t => !document.body.innerText.includes(t), text, { timeout: 8000 });

    // Pre-condition: no visible "Repair" text yet (an undamaged canvas
    // with no failing components shouldn't show one).
    await offScreen('Repair').catch(() => {
        throw new Error('"Repair" was already visible before damage');
    });

    // Corrupt index.json mid-session — the watcher sees the change.
    const indexPath = path.join(workspace, 'home', 'index.json');
    fs.writeFileSync(indexPath, '{ this is not valid JSON', 'utf8');

    // "Repair" surfaces — the user sees a broken canvas and can act on it.
    await onScreen('Repair').catch(() => {
        throw new Error('"Repair" never appeared on screen after the canvas was damaged');
    });
};
