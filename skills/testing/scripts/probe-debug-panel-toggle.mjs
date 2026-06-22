//
// probe-debug-panel-toggle.mjs
//
// Debug panel is hidden by default. window.liquidos.toggleDebug()
// shows it; calling again hides it. The Mac app's View menu calls
// this same JS, so verifying the toggle in a sandbox is verifying
// what the menu drives.
//
// Visibility is asserted via document.body.innerText: the panel
// contains a "Copy" button that is only visible when the panel is
// open. When hidden, "Copy" is absent from the page's text.
//
// Run it:  node run-probe.mjs probe-debug-panel-toggle.mjs
//

export const fixture = './probe-debug-panel-toggle.liquidos';

// "Copy" is the panel's own static label — present only when the
// debug rail is visible on screen.
const PANEL_LABEL = 'Copy';

const panelVisible = (page) => page.evaluate(
    label => document.body.innerText.includes(label),
    PANEL_LABEL
);

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

    // 1. Hidden by default — "Copy" not on screen.
    if (await panelVisible(page)) {
        throw new Error('debug panel visible on first load — should be hidden by default ("Copy" present in innerText)');
    }

    // 2. toggleDebug shows it — "Copy" appears.
    const r1 = await page.evaluate(() => window.liquidos?.toggleDebug?.());
    if (r1 !== true) {
        throw new Error('toggleDebug() should return true when opening, returned ' + r1);
    }
    if (!await panelVisible(page)) {
        throw new Error('debug panel still hidden after toggleDebug() — "Copy" not in innerText');
    }

    // 3. toggleDebug again hides it — "Copy" disappears.
    const r2 = await page.evaluate(() => window.liquidos?.toggleDebug?.());
    if (r2 !== false) {
        throw new Error('toggleDebug() should return false when closing, returned ' + r2);
    }
    if (await panelVisible(page)) {
        throw new Error('debug panel still visible after second toggleDebug() — "Copy" still in innerText');
    }

    // 4. State persists across reload (open then reload, must stay open).
    //    Visible signal: "Copy" is on screen after reload.
    await page.evaluate(() => window.liquidos?.toggleDebug?.());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
    if (!await panelVisible(page)) {
        throw new Error('debug panel did not stay open after reload — localStorage persistence broken ("Copy" absent)');
    }

    // 5. A previously-stored width must not reserve a grid column when
    //    the panel is closed. This is the "panel hidden but the canvas
    //    still leaves a dark gutter on the left" bug.
    //
    //    FLAG: this assertion has no visible-string equivalent — the bug
    //    manifests as a phantom layout column of invisible pixels, not as
    //    any text the user can read. The CSS variable --debug-rail-width
    //    is the only reliable signal. Left as a geometry assertion.
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
