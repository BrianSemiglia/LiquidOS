//
// probe-component-chrome-collapses.mjs
//
// The harness reserves a row above each component for its Requirements button,
// but that reserved space must COLLAPSE when the button is hidden — otherwise
// an immersive (button-less) canvas carries an empty gap above every card.
//
// The button rides with the prompt bar: shown in the stepped-back state, gone
// when Escape hides the prompt bar. So:
//   - prompt bar up   → button shown → a real gap above the component content.
//   - prompt bar down → button hidden → that gap collapses to ~nothing.
//
// FLAG: genuine layout test. The reserved-space invariant is geometric (the
// gap between the component frame's top and its content), so this measures
// boxes rather than reading a string. Keep it geometric.
//
// Run it:  node run-probe.mjs probe-component-chrome-collapses.mjs
//

export const fixture = './probe-component-chrome-collapses.liquidos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
        () => visibleText().includes('placed by old-shape canvas'),
        undefined, { timeout: 15000 });
    await sleep(400);

    // Reserved space = the gap between the component frame's top and its
    // content face's top (i.e. the height of the chrome row above the card).
    const chromeRowGap = () => page.evaluate(() => {
        const frame = document.querySelector('.harness-component-frame-watcher');
        const front = frame?.querySelector('.component-front');
        if (!frame || !front) return null;
        return front.getBoundingClientRect().top - frame.getBoundingClientRect().top;
    });

    // Prompt bar up (default): the button shows, so the row reserves space.
    const shownGap = await chromeRowGap();
    if (shownGap === null) throw new Error('component frame/front not found');
    if (shownGap < 10) {
        throw new Error('chrome row did not reserve space while the button was shown — gap=' + shownGap);
    }
    console.log('  ok  button shown: chrome row reserves space — gap=' + Math.round(shownGap));

    // Escape hides the prompt bar → button hidden → reserved row collapses.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.body.dataset.promptHidden === 'true',
        undefined, { timeout: 4000 }).catch(() => {});
    await sleep(400); // let the max-height transition finish

    const hiddenGap = await chromeRowGap();
    if (hiddenGap === null) throw new Error('component frame/front not found after Escape');
    if (hiddenGap > 2) {
        throw new Error('chrome row did not collapse when the button was hidden — gap=' + hiddenGap);
    }
    console.log('  ok  button hidden: chrome row collapsed — gap=' + Math.round(hiddenGap));
};
