//
// probe-agent-picker-debug-only.mjs
//
// The agent picker is a debug-only control. In the normal view the
// prompt bar shows only the text input and the send arrow; the picker
// rides with the debug rail and is hidden otherwise. Toggling the debug
// view (the same window.liquidos.toggleDebug() the Mac app's View menu
// calls) reveals it, and toggling back hides it again.
//
// FLAG: the picker is a <select> whose only text is the dynamic agent
// names it's populated with — it has no static label of its own, and a
// <select>'s option text is not reliably present in visibleText()
// across engines. So, like the geometry assertion in
// probe-debug-panel-toggle.mjs, visibility here is asserted by the
// element's actual rendered state (isVisible() — display:none vs shown),
// which is precisely what a person perceives on screen. The prompt
// textarea is checked the normal way (it must stay reachable throughout)
// so the test still discriminates: a build that hid the whole bar would
// fail it.
//
// Run it:  node run-probe.mjs probe-agent-picker-debug-only.mjs
//

export const fixture = './probe-agent-picker-debug-only.liquidos';

const pickerVisible = (page) => page.locator('#agent-select').isVisible();

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // The picker and the prompt are both in the bar from the start; only
    // the picker's visibility is gated on the debug view.
    await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });
    // 'attached', not 'visible': the picker lives in the DOM from the
    // start but is hidden until the debug view opens — waiting for it to
    // be visible would deadlock against the very behaviour under test.
    await page.waitForSelector('#agent-select', { state: 'attached', timeout: 20000 });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });

    // Start from a known-closed debug state (clear any persisted toggle).
    await page.evaluate(() => { try { localStorage.removeItem('liquidos:debug-open'); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });

    const promptReachable = () => page.getByRole('textbox', { name: 'Prompt' }).isVisible();

    // 1. Debug closed by default → picker hidden, prompt still usable.
    if (await pickerVisible(page)) {
        throw new Error('agent picker visible on first load — should be hidden when the debug view is closed');
    }
    if (!await promptReachable()) {
        throw new Error('prompt input not visible on first load — the bar should always be usable');
    }

    // 2. Open the debug view → picker appears.
    const opened = await page.evaluate(() => window.liquidos?.toggleDebug?.());
    if (opened !== true) {
        throw new Error('toggleDebug() should return true when opening, returned ' + opened);
    }
    if (!await pickerVisible(page)) {
        throw new Error('agent picker still hidden after opening the debug view — it should show alongside the debug rail');
    }

    // 3. Close the debug view → picker hides again, prompt unaffected.
    const closed = await page.evaluate(() => window.liquidos?.toggleDebug?.());
    if (closed !== false) {
        throw new Error('toggleDebug() should return false when closing, returned ' + closed);
    }
    if (await pickerVisible(page)) {
        throw new Error('agent picker still visible after closing the debug view — it should hide with the rail');
    }
    if (!await promptReachable()) {
        throw new Error('prompt input disappeared when the debug view closed — only the picker should hide');
    }

    // 4. Gating survives a reload: reopen, reload, picker is back.
    await page.evaluate(() => window.liquidos?.toggleDebug?.());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#agent-select', { state: 'attached', timeout: 20000 });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
    if (!await pickerVisible(page)) {
        throw new Error('agent picker absent after reload with the debug view open — visibility should track the persisted debug state');
    }

    // Clean up the persisted toggle so later probes start closed.
    await page.evaluate(() => { try { localStorage.removeItem('liquidos:debug-open'); } catch {} });
    console.log('agent picker hidden by default, shown only with the debug view, prompt always reachable');
};
