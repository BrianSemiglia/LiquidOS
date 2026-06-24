//
// probe-suggestions-per-canvas.mjs
//
// Suggestions are scoped to the active canvas. Driven exactly as a user would:
// focus the prompt bar and press Tab to accept the canvas's top suggestion into
// the field, then read the visible text now sitting in the bar. home and other
// carry distinct first suggestions; switching canvases swaps which one Tab
// brings in, and the previous canvas's suggestion never lingers.
//
// Run it:  node run-probe.mjs probe-suggestions-per-canvas.mjs
//

export const fixture = './probe-suggestions-per-canvas.liquidos';

const HOME_FIRST = 'ALPHA make the header bigger';
const OTHER_FIRST = 'DELTA rename this canvas';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// What a user gets by accepting the bar's top suggestion: clear the field so the
// ghost is offered, focus, press Tab, and read the text the bar now shows.
const acceptTopSuggestion = async (page) => {
    const bar = page.locator('#global-text');
    await bar.fill('');
    await bar.focus();
    await bar.press('Tab');
    return (await bar.inputValue()).trim();
};

// Tab brings nothing in until the canvas's list has loaded, so keep accepting
// until the bar shows the expected suggestion (or give up).
const expectTopSuggestion = async (page, want, label) => {
    const deadline = Date.now() + 8000;
    let seen = '';
    do {
        seen = await acceptTopSuggestion(page);
        if (seen === want) return;
        await sleep(150);
    } while (Date.now() < deadline);
    throw new Error(`${label}: expected the bar to offer "${want}", but Tab brought in "${seen}"`);
};

const switchTo = async (page, canvas) => {
    await page.locator('#canvas-overview-toggle').dispatchEvent('click');
    await page.waitForSelector(`.canvas-grid-card[data-canvas="${canvas}"]`, { timeout: 5000 });
    await page.locator(`.canvas-grid-card[data-canvas="${canvas}"]`).dispatchEvent('click');
};

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#global-text', { timeout: 20000 });

    // home offers home's suggestion.
    await expectTopSuggestion(page, HOME_FIRST, 'home');

    // Switch to other → Tab now brings in other's suggestion instead.
    await switchTo(page, 'other');
    await expectTopSuggestion(page, OTHER_FIRST, 'after switching to "other"');

    // Switch back to home → home's suggestion is offered again, not a stale "other".
    await switchTo(page, 'home');
    await expectTopSuggestion(page, HOME_FIRST, 'after switching back to "home"');
};
