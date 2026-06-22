//
// probe-flip-button-toggle.mjs
//
// Verifies the component flip-button text toggles between 'Requirements'
// (front, click to open the back) and 'Close' (back, click to return).
//
// Run it:  node run-probe.mjs probe-flip-button-toggle.mjs
//

export const fixture = './probe-flip-button-toggle.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-probe]', { timeout: 20000 });
    await sleep(1500);

    // Located by its accessible name (aria-label), which stays constant while
    // the visible label toggles Requirements ↔ Close — and which still resolves
    // once the button moves into the open requirements overlay.
    const flip = page.locator('[aria-label="Edit Probe requirements"]');
    const front = await flip.textContent();
    if ((front || '').trim() !== 'Requirements') {
        throw new Error('front state should read "Requirements", got: ' + front);
    }
    await flip.dispatchEvent('click');
    await sleep(400);
    const back = await flip.textContent();
    if ((back || '').trim() !== 'Close') {
        throw new Error('back state should read "Close", got: ' + back);
    }
    await flip.dispatchEvent('click');
    await sleep(400);
    const frontAgain = await flip.textContent();
    if ((frontAgain || '').trim() !== 'Requirements') {
        throw new Error('after closing, button should read "Requirements" again, got: ' + frontAgain);
    }
    console.log('front:', front, '→ back:', back, '→ front again:', frontAgain);
};
