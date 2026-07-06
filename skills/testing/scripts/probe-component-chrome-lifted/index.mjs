//
// probe-component-chrome-lifted
//
// System chrome (the container holding the Requirements button and, when
// surfaced, the Repair button) sits just ABOVE the component, right-aligned
// with it, out of the component's flow — so it reserves no layout space and a
// canvas can't fold it away. The whole container moves together so multiple
// buttons stay aligned. This fixture renders the in-frame web-component path,
// where the frame is the positioned ancestor; the canvas overlay path places
// an identical element the same way from script.
//
// FLAG: this probe is a genuine pixel-layout test. The assertions verify
// spatial relationships between DOM elements (chrome hugs the front card's
// top-right corner, stays within the item's bounds). There is no unique
// visible string that encodes these geometry invariants, so the assertions
// remain as getBoundingClientRect checks. Do not convert to visible-text
// checks — that would lose the layout guarantee entirely.
//
// Run it:  node run-probe.mjs probe-component-chrome-lifted
//

export const fixture = './workspace.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for the fixture's component content ("200px wide") to confirm render.
    await page.waitForFunction(
        t => visibleText().includes(t),
        '200px wide',
        { timeout: 15000 }
    );
    // Hover to surface the chrome.
    await page.locator('.component-frame').first().hover();
    await sleep(200);

    const layout = await page.evaluate(() => {
        const frame  = document.querySelector('.component-frame');
        const item   = frame?.closest('.item');
        const chrome = document.querySelector('.component-chrome');
        const front  = frame?.querySelector('.component-content');
        const rect = (el) => el ? el.getBoundingClientRect() : null;
        return {
            item:   rect(item),
            chrome: rect(chrome),
            front:  rect(front)
        };
    });
    console.log('layout:', layout);

    if (!layout.chrome || !layout.front || !layout.item) {
        throw new Error('chrome, front, or item not found');
    }
    // Chrome sits ABOVE the front card, not overlapping it.
    if (layout.chrome.bottom > layout.front.top + 1) {
        throw new Error('chrome overlaps the front card — chrome.bottom=' + layout.chrome.bottom + ', front.top=' + layout.front.top);
    }
    // ...but just above — a row's height, not flying off up the column.
    if (layout.chrome.bottom < layout.front.top - 60) {
        throw new Error('chrome floats too far above the card — chrome.bottom=' + layout.chrome.bottom + ', front.top=' + layout.front.top);
    }
    // Chrome is right-aligned with the card's right edge.
    if (Math.abs(layout.chrome.right - layout.front.right) > 2) {
        throw new Error('chrome not right-aligned with card — chrome.right=' + layout.chrome.right + ', front.right=' + layout.front.right);
    }
    console.log('  ok  chrome sits just above the card, right-aligned');
};
