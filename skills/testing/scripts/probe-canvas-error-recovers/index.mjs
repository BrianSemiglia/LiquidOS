//
// probe-canvas-error-recovers
//
// Canvas boots damaged → user sees "Repair" on screen. The probe then
// rewrites index.json to a valid state (the "agent's fix"). The
// harness's canvasError clears, the canvas should paint its
// components fresh ("canvas repaired" is visible), and "Repair"
// must leave the screen. Without that, restarting the app is the
// only way the user sees the fix.
//
// Run it:  node run-probe.mjs probe-canvas-error-recovers
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './workspace.liquidos';

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const onScreen = (text) => page.waitForFunction(
        t => visibleText().includes(t), text, { timeout: 10000 });
    const offScreen = (text) => page.waitForFunction(
        t => !visibleText().includes(t), text, { timeout: 5000 });

    // The fixture boots with a broken index.json → "Repair" appears.
    await onScreen('Repair').catch(() => {
        throw new Error('"Repair" never appeared on screen for the damaged canvas');
    });

    // Simulate the agent's fix: rewrite index.json to point at the
    // pre-staged repaired component.
    const indexPath = path.join(workspace, 'home', 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify({
        components: ['components/canvas-repaired/component.html']
    }, null, 2) + '\n');

    // The repaired component's content must appear on screen...
    await onScreen('canvas repaired').catch(() => {
        throw new Error('"canvas repaired" never appeared after the fix');
    });
    // ...and "Repair" must be gone.
    await offScreen('Repair').catch(() => {
        throw new Error('"Repair" did not leave the screen after the canvas was fixed');
    });
};
