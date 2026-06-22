//
// probe-suggestions-per-canvas.mjs
//
// Suggestions are scoped to the active canvas: each canvas shows its own list,
// and switching canvases swaps the ghost — the previous canvas's suggestions
// never linger. home and other carry distinct, recognizable first suggestions.
//
// Run it:  node run-probe.mjs probe-suggestions-per-canvas.mjs
//

export const fixture = 'suggestions.liquidos';

const HOME_FIRST = 'ALPHA make the header bigger';
const OTHER_FIRST = 'DELTA rename this canvas';

const ghostIs = (page, text, timeout = 6000) => page.waitForFunction(
    t => document.getElementById('global-text').placeholder === t, text, { timeout });

const switchTo = async (page, canvas) => {
    await page.locator('#canvas-overview-toggle').dispatchEvent('click');
    await page.waitForSelector(`.canvas-grid-card[data-canvas="${canvas}"]`, { timeout: 5000 });
    await page.locator(`.canvas-grid-card[data-canvas="${canvas}"]`).dispatchEvent('click');
    await page.waitForFunction(c => document.body.dataset.currentCanvas === c, canvas, { timeout: 5000 });
};

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#global-text', { timeout: 20000 });

    // home shows home's first suggestion.
    await ghostIs(page, HOME_FIRST, 8000).catch(() => { throw new Error('home did not show its own first suggestion'); });

    // Switch to other → its own suggestion replaces home's.
    await switchTo(page, 'other');
    await ghostIs(page, OTHER_FIRST).catch(() => { throw new Error('switching to "other" did not swap in its suggestion'); });

    // Switch back to home → home's suggestion is back (and not stale "other").
    await switchTo(page, 'home');
    await ghostIs(page, HOME_FIRST).catch(() => { throw new Error('switching back to "home" did not restore home\'s suggestion'); });
};
