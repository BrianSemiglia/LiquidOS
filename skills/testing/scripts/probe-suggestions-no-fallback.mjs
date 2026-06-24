//
// probe-suggestions-no-fallback.mjs
//
// A canvas with no suggestions file shows NOTHING — there is no built-in /
// generic fallback. Driven as a user would: on home, pressing Tab accepts the
// canvas's top suggestion into the bar; after switching to the "bare" canvas
// (which has no suggestions.json), Tab brings in nothing — the bar stays empty.
//
// Run it:  node run-probe.mjs probe-suggestions-no-fallback.mjs
//

export const fixture = './probe-suggestions-no-fallback.liquidos';

const HOME_FIRST = 'ALPHA make the header bigger';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// What a user gets by accepting the bar's top suggestion: clear the field so the
// ghost is offered, focus, press Tab, and read the text the bar now shows.
// Returns '' when there is nothing to accept.
const acceptTopSuggestion = async (page) => {
    const bar = page.locator('#global-text');
    await bar.fill('');
    await bar.focus();
    await bar.press('Tab');
    return (await bar.inputValue()).trim();
};

// Keep accepting until the bar offers exactly `want` (or give up). An empty
// `want` proves Tab brings in nothing — the no-fallback case.
const expectTopSuggestion = async (page, want, label) => {
    const deadline = Date.now() + 8000;
    let seen = '';
    do {
        seen = await acceptTopSuggestion(page);
        if (seen === want) return;
        await sleep(150);
    } while (Date.now() < deadline);
    throw new Error(`${label}: expected Tab to bring in ${JSON.stringify(want)}, but it brought in ${JSON.stringify(seen)}`);
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

    // home has suggestions — Tab brings its first one in. Confirms the bar works,
    // so the "nothing on bare" check below is meaningful and not a load race.
    await expectTopSuggestion(page, HOME_FIRST, 'home');

    // Switch to the bare canvas (no suggestions.json) the way a user would.
    await switchTo(page, 'bare');

    // No file → no fallback: Tab has nothing to accept, the bar stays empty.
    await expectTopSuggestion(page, '', 'bare canvas (no suggestions file)');
};
