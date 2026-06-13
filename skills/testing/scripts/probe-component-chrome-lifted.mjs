//
// probe-component-chrome-lifted.mjs
//
// The chrome row above each component (the container holding the
// Requirements button and, when surfaced, the Repair button) should
// sit ABOVE the component card without taking up layout space inside
// it. The whole container lifts together so multiple buttons stay
// aligned.
//
// Run it:  node run-probe.mjs probe-component-chrome-lifted.mjs
//

export const fixture = 'requirements-modal-intrinsic.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-narrow]', { timeout: 15000 });
    // Hover to surface the chrome.
    await page.locator('.harness-component-frame-watcher').first().hover();
    await sleep(200);

    const layout = await page.evaluate(() => {
        const item   = document.querySelector('.harness-component-frame-watcher')?.closest('.item');
        const frame  = document.querySelector('.harness-component-frame-watcher');
        const chrome = frame?.querySelector('.component-chrome');
        const front  = frame?.querySelector('.component-front');
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
    // Chrome must sit ABOVE the front, not overlap it.
    if (layout.chrome.bottom > layout.front.top + 1) {
        throw new Error('chrome overlaps the front card — chrome.bottom=' + layout.chrome.bottom + ', front.top=' + layout.front.top);
    }
    // Chrome must stay INSIDE the item's bounds — not lifted above
    // into a neighboring component's space.
    if (layout.chrome.top < layout.item.top - 1) {
        throw new Error('chrome leaks above item — chrome.top=' + layout.chrome.top + ', item.top=' + layout.item.top);
    }
    // Chrome should be aligned to the right edge of the card.
    if (Math.abs(layout.chrome.right - layout.front.right) > 2) {
        throw new Error('chrome not right-aligned with card — chrome.right=' + layout.chrome.right + ', front.right=' + layout.front.right);
    }
};
