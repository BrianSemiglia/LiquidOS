//
// probe-suggestions-placeholder.mjs
//
// The empty prompt bar ghosts in the active canvas's suggestions. This drives
// the bar the way a user does and asserts the on-screen ghost text:
//   - on load the first suggestion shows as the placeholder
//   - ArrowDown / ArrowUp step through the list (only while focused)
//   - Tab accepts the current suggestion as typed text in the field
//   - deleting back to empty brings the ghost back
//
// The placeholder is the visible ghost the user reads in an empty field; it has
// no innerText node, so the rendered `placeholder` string IS the visible text
// we assert. After Tab the suggestion becomes the field's `value` — the visible
// text typed into the box.
//
// Run it:  node run-probe.mjs probe-suggestions-placeholder.mjs
//

export const fixture = './probe-suggestions-placeholder.liquidos';

const ALPHA = 'ALPHA make the header bigger';
const BRAVO = 'BRAVO add a dark mode toggle';
const CHARLIE = 'CHARLIE show the current time';

const ghostIs = (page, text, timeout = 6000) => page.waitForFunction(
    t => document.getElementById('global-text').placeholder === t, text, { timeout });
const valueIs = (page, text, timeout = 6000) => page.waitForFunction(
    t => document.getElementById('global-text').value === t, text, { timeout });

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#global-text', { timeout: 20000 });

    // First suggestion ghosts into the empty bar (no focus needed).
    await ghostIs(page, ALPHA, 8000).catch(() => {
        throw new Error('the first suggestion never appeared as the empty-bar ghost');
    });

    // ArrowDown steps forward through the list; ArrowUp steps back.
    await page.locator('#global-text').focus();
    await page.keyboard.press('ArrowDown');
    await ghostIs(page, BRAVO).catch(() => { throw new Error('ArrowDown did not advance to the next suggestion'); });
    await page.keyboard.press('ArrowDown');
    await ghostIs(page, CHARLIE).catch(() => { throw new Error('ArrowDown did not advance to the third suggestion'); });
    await page.keyboard.press('ArrowUp');
    await ghostIs(page, BRAVO).catch(() => { throw new Error('ArrowUp did not step back to the previous suggestion'); });

    // Tab accepts the current suggestion (BRAVO) into the field as typed text.
    await page.keyboard.press('Tab');
    await valueIs(page, BRAVO).catch(() => { throw new Error('Tab did not fill the field with the current suggestion'); });

    // Clearing the field back to empty restores the ghost (the current one).
    await page.locator('#global-text').fill('');
    await ghostIs(page, BRAVO).catch(() => {
        throw new Error('clearing the field did not bring the ghost suggestion back');
    });
};
