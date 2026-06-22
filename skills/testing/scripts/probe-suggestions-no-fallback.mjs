//
// probe-suggestions-no-fallback.mjs
//
// A canvas with no suggestions file shows NOTHING — there is no built-in /
// generic fallback. Switch to the "bare" canvas (which has no suggestions.json)
// and assert the bar's ghost is empty and that Tab can't fill it with anything.
//
// The placeholder is the visible ghost text the user reads in an empty field;
// asserting it is empty is asserting nothing shows on screen.
//
// Run it:  node run-probe.mjs probe-suggestions-no-fallback.mjs
//

export const fixture = 'suggestions.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#global-text', { timeout: 20000 });

    // Default canvas (home) does have suggestions — confirm one is showing, so
    // the "empty on bare" assertion below is meaningful and not a load race.
    await page.waitForFunction(
        () => document.getElementById('global-text').placeholder.length > 0,
        { timeout: 8000 }
    ).catch(() => { throw new Error('home suggestions never loaded; can not test the no-fallback case'); });

    // Switch to the bare canvas via the zoom-out grid, the way a user would.
    await page.locator('#canvas-overview-toggle').dispatchEvent('click');
    await page.waitForSelector('.canvas-grid-card[data-canvas="bare"]', { timeout: 5000 });
    await page.locator('.canvas-grid-card[data-canvas="bare"]').dispatchEvent('click');
    await page.waitForFunction(() => document.body.dataset.currentCanvas === 'bare', { timeout: 5000 });

    // No file → nothing ghosts in.
    await page.waitForFunction(
        () => document.getElementById('global-text').placeholder === '',
        { timeout: 6000 }
    ).catch(() => { throw new Error('a canvas with no suggestions file still showed a ghost suggestion (a fallback leaked)'); });

    // And Tab has nothing to accept — the field stays empty.
    await page.locator('#global-text').focus();
    await page.keyboard.press('Tab');
    await sleep(200);
    const value = await page.evaluate(() => document.getElementById('global-text').value);
    if (value !== '') {
        throw new Error('Tab filled the field on a canvas with no suggestions: ' + JSON.stringify(value));
    }
};
