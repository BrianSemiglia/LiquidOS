//
// probe-agent-picker-always-visible
//
// The agent picker is part of the prompt bar proper, not a debug-only
// control: it's visible in the normal view and stays visible no matter
// whether the debug view is open or closed. Choosing which agent handles
// your prompt is something you do while working, so the picker rides with
// the input and send arrow at all times.
//
// FLAG: the picker is a <select> whose only text is the dynamic agent
// names it's populated with — it has no static label of its own, and a
// <select>'s option text is not reliably present in visibleText() across
// engines. So visibility here is asserted by the element's actual rendered
// state (isVisible() — display:none vs shown), which is precisely what a
// person perceives on screen. The prompt textarea is checked the same way
// so the test still discriminates: a build that hid the whole bar would
// fail it, and a build that gated the picker on the debug view (the old
// behaviour) would fail the debug-closed assertions.
//
// Run it:  node run-probe.mjs probe-agent-picker-always-visible
//

export const fixture = './workspace.liquidos';

const pickerVisible = (page) => page.locator('#agent-select').isVisible();

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });
    await page.waitForSelector('#agent-select', { state: 'attached', timeout: 20000 });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });

    // Start from a known-closed debug state (clear any persisted toggle).
    await page.evaluate(() => { try { localStorage.removeItem('liquidos:debug-open'); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });

    const promptReachable = () => page.getByRole('textbox', { name: 'Prompt' }).isVisible();

    // 1. Debug closed by default → picker already visible, prompt usable.
    if (!await pickerVisible(page)) {
        throw new Error('agent picker hidden on first load — it should be visible even when the debug view is closed');
    }
    if (!await promptReachable()) {
        throw new Error('prompt input not visible on first load — the bar should always be usable');
    }

    // 2. Open the debug view → picker stays visible.
    const opened = await page.evaluate(() => window.liquidos?.toggleDebug?.());
    if (opened !== true) {
        throw new Error('toggleDebug() should return true when opening, returned ' + opened);
    }
    if (!await pickerVisible(page)) {
        throw new Error('agent picker disappeared when the debug view opened — it should stay put');
    }

    // 3. Close the debug view again → picker still visible, prompt unaffected.
    const closed = await page.evaluate(() => window.liquidos?.toggleDebug?.());
    if (closed !== false) {
        throw new Error('toggleDebug() should return false when closing, returned ' + closed);
    }
    if (!await pickerVisible(page)) {
        throw new Error('agent picker hidden after closing the debug view — its visibility should not track the debug state');
    }
    if (!await promptReachable()) {
        throw new Error('prompt input disappeared when the debug view closed — the bar should always be usable');
    }

    // 4. Survives a reload with the debug view closed: picker is still there.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#agent-select', { state: 'attached', timeout: 20000 });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
    if (!await pickerVisible(page)) {
        throw new Error('agent picker absent after reload with the debug view closed — it should always be visible');
    }

    // Clean up the persisted toggle so later probes start closed.
    await page.evaluate(() => { try { localStorage.removeItem('liquidos:debug-open'); } catch {} });
    console.log('agent picker visible with the debug view closed and open alike; prompt always reachable');
};
