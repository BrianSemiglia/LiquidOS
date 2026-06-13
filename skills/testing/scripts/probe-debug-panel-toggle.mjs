//
// probe-debug-panel-toggle.mjs
//
// Debug panel is hidden by default. window.liquidos.toggleDebug()
// shows it; calling again hides it. The Mac app's View menu calls
// this same JS, so verifying the toggle in a sandbox is verifying
// what the menu drives.
//
// Run it:  node run-probe.mjs probe-debug-panel-toggle.mjs
//

export const fixture = 'canvas-build.liquidos';

const railVisible = (page) => page.evaluate(() => {
    const rail = document.querySelector('.debug-rail');
    if (!rail) return false;
    const style = getComputedStyle(rail);
    return style.display !== 'none' && rail.getBoundingClientRect().width > 0;
});

export default async ({ url, page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Module script that defines toggleDebug runs after an async import.
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
    // Clear any persisted state from previous runs.
    await page.evaluate(() => { try { localStorage.removeItem('liquidos:debug-open'); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });

    // 1. Hidden by default.
    if (await railVisible(page)) {
        throw new Error('debug rail visible on first load — should be hidden by default');
    }

    // 2. toggleDebug shows it.
    const r1 = await page.evaluate(() => window.liquidos?.toggleDebug?.());
    if (r1 !== true) {
        throw new Error('toggleDebug() should return true when opening, returned ' + r1);
    }
    if (!await railVisible(page)) {
        throw new Error('debug rail still hidden after toggleDebug()');
    }

    // 3. toggleDebug again hides it.
    const r2 = await page.evaluate(() => window.liquidos?.toggleDebug?.());
    if (r2 !== false) {
        throw new Error('toggleDebug() should return false when closing, returned ' + r2);
    }
    if (await railVisible(page)) {
        throw new Error('debug rail still visible after second toggleDebug()');
    }

    // 4. State persists across reload (open then reload, must stay open).
    await page.evaluate(() => window.liquidos?.toggleDebug?.());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
    if (!await railVisible(page)) {
        throw new Error('debug rail did not stay open after reload — localStorage persistence broken');
    }

    // 5. A previously-stored width must not reserve a grid column when
    // the panel is closed. This is the "panel hidden but the canvas
    // still leaves a dark gutter on the left" bug.
    await page.evaluate(() => {
        try {
            // Pretend the user previously dragged the rail wider.
            localStorage.setItem('live-edit-debug-rail-width', '420');
        } catch {}
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
    // Make sure we're in the closed state for the check.
    await page.evaluate(() => window.liquidos.setDebugOpen(false));
    const closedRailWidth = await page.evaluate(() =>
        getComputedStyle(document.body).getPropertyValue('--debug-rail-width').trim());
    if (closedRailWidth !== '0px') {
        throw new Error('--debug-rail-width is ' + closedRailWidth + ' when panel closed — body grid still reserves a column');
    }

    // Clean up.
    await page.evaluate(() => {
        try {
            localStorage.removeItem('liquidos:debug-open');
            localStorage.removeItem('live-edit-debug-rail-width');
        } catch {}
    });
};
