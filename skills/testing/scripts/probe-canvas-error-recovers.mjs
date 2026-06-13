//
// probe-canvas-error-recovers.mjs
//
// Canvas boots damaged → user sees the Repair card. The probe then
// rewrites input.json to a valid state (the "agent's fix"). The
// harness's canvasError clears, the canvas should paint its
// components fresh, and the Repair card must leave the DOM. Without
// that, restarting the app is the only way the user sees the fix.
//
// Run it:  node run-probe.mjs probe-canvas-error-recovers.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = 'canvas-damaged-repair.liquidos';

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // The fixture boots with a broken input.json → Repair card appears.
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button'))
            .some(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0),
        { timeout: 10000 }
    );

    // Simulate the agent's fix: rewrite input.json to point at the
    // pre-staged repaired component.
    const inputPath = path.join(workspace, 'home', 'input.json');
    fs.writeFileSync(inputPath, JSON.stringify({
        components: ['components/canvas-repaired/component.html']
    }, null, 2) + '\n');

    // The repaired component's view marker must appear...
    await page.waitForSelector('[data-canvas-repair-marker]', { timeout: 10000 });
    // ...and the Repair card must be gone.
    await page.waitForFunction(
        () => !document.querySelector('[role="group"][data-repair-level="canvas"]'),
        { timeout: 5000 }
    );
};
