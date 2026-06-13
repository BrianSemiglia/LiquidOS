//
// probe-canvas-damaged.mjs
//
// A malformed input.json on the active canvas surfaces a red "canvas-
// repair" card in the DOM with a Repair button. The probe writes a bad
// input.json into the sandbox after boot (so the harness sees the
// change), then asserts on the rendered card.
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

    // Pre-condition: no visible Repair button yet (an undamaged canvas
    // with no failing components shouldn't show one).
    const visibleRepairs = () => page.evaluate(() => {
        return Array.from(document.querySelectorAll('button'))
            .filter(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0)
            .length;
    });
    if (await visibleRepairs() !== 0) {
        throw new Error('a Repair button was already visible before damage');
    }

    // Corrupt input.json mid-session — the watcher sees the change.
    const inputPath = path.join(workspace, 'home', 'input.json');
    fs.writeFileSync(inputPath, '{ this is not valid JSON', 'utf8');

    // A Repair button surfaces — the user sees a broken canvas and can act on it.
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button'))
            .some(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0),
        { timeout: 8000 }
    );
};
