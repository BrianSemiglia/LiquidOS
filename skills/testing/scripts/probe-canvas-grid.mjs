//
// probe-canvas-grid.mjs
//
// The top-left "Spaces" button zooms the canvas out to a grid of all canvases:
//   - the grid shows a named card per canvas plus a "Create" card;
//   - the prompt bar stays visible while zoomed out (you can still prompt);
//   - the top-right canvas Requirements button is hidden while zoomed out;
//   - "Create" opens the usual browse / new-from-scratch flow, as a back-stack:
//     grid → browse → name modal, with Escape/Cancel stepping back one level;
//   - picking a canvas card switches to it and closes the grid;
//   - Escape closes the grid (and the Requirements button comes back).
//
// Asserts visible strings (canvas names, the prompt bar's "↑" Send glyph, the browse
// flow's copy, the "Create" card) coming and going — never geometry or flags.
//
// Run it:  node run-probe.mjs probe-canvas-grid.mjs
//

export const fixture = './probe-canvas-grid.liquidos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  const onScreen = (text, timeout = 6000) => page.waitForFunction(
    t => document.body.innerText.includes(t), text, { timeout });
  const offScreen = (text, timeout = 6000) => page.waitForFunction(
    t => !document.body.innerText.includes(t), text, { timeout });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#canvas-overview-toggle', { timeout: 20000 });
  await sleep(1000);

  // The prompt bar is up to begin with, and the top-left button reads "Spaces".
  // The Send control is a glyph button ("↑"); its presence means the bar is up.
  await onScreen('↑').catch(() => { throw new Error('prompt bar not visible at start'); });
  await onScreen('Spaces').catch(() => { throw new Error('top-left button should read "Spaces"'); });
  // The canvas Requirements button is present while on a single canvas.
  await page.locator('#canvas-reqs-toggle').waitFor({ state: 'visible', timeout: 5000 });

  // 1. Zoom out → the grid shows a card per canvas (home, other) and "Create".
  await page.locator('#canvas-overview-toggle').dispatchEvent('click');
  await page.waitForSelector('.canvas-grid-card[data-canvas="other"]', { timeout: 5000 });
  const cardTexts = await page.locator('.canvas-grid-card').allInnerTexts();
  for (const expected of ['home', 'other', 'Create']) {
    if (!cardTexts.some(t => t.includes(expected))) {
      throw new Error(`grid card "${expected}" missing; saw: ${cardTexts.join(' | ')}`);
    }
  }
  console.log('  ok  zoom-out shows a card per canvas plus "Create"');

  // 2. The prompt bar stays visible while zoomed out.
  await onScreen('↑').catch(() => { throw new Error('prompt bar should stay visible in the grid view'); });
  console.log('  ok  the prompt bar stays visible in the grid view');

  // 2b. The canvas Requirements button is hidden while zoomed out.
  await page.locator('#canvas-reqs-toggle').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {
    throw new Error('canvas Requirements button should be hidden in the grid view');
  });
  console.log('  ok  the canvas Requirements button is hidden in the grid view');

  // 3. The new-canvas flow is a back-stack: grid → browse → name modal, and
  //    Escape/Cancel steps back one level at a time (not all the way out).
  const BROWSE = 'Create an empty canvas and build it with the agent';
  const NAME_MODAL = 'New Canvas';

  // "Create" opens the browse overlay (grid stays underneath).
  await page.locator('#canvas-grid-new').dispatchEvent('click');
  await onScreen(BROWSE).catch(() => { throw new Error('"Create" did not open the browse flow'); });

  // "from scratch" opens the name modal (browse stays underneath).
  await page.locator('#browse-from-scratch').dispatchEvent('click');
  await onScreen(NAME_MODAL).catch(() => { throw new Error('"from scratch" did not open the name modal'); });

  // Escape from the name modal steps back to browse.
  await page.keyboard.press('Escape');
  await offScreen(NAME_MODAL).catch(() => { throw new Error('Escape did not close the name modal'); });
  await onScreen(BROWSE).catch(() => { throw new Error('Escape from the name modal should return to browse'); });
  console.log('  ok  Escape from the name modal steps back to the browse overlay');

  // Cancel from the name modal also steps back to browse.
  await page.locator('#browse-from-scratch').dispatchEvent('click');
  await onScreen(NAME_MODAL).catch(() => { throw new Error('name modal did not reopen'); });
  await page.locator('#new-canvas-cancel').dispatchEvent('click');
  await offScreen(NAME_MODAL).catch(() => { throw new Error('Cancel did not close the name modal'); });
  await onScreen(BROWSE).catch(() => { throw new Error('Cancel from the name modal should return to browse'); });
  console.log('  ok  Cancel from the name modal steps back to the browse overlay');

  // Escape from browse steps back to the grid (not out to the canvas).
  await page.keyboard.press('Escape');
  await offScreen(BROWSE).catch(() => { throw new Error('Escape did not close the browse overlay'); });
  await page.locator('#canvas-grid-overlay').waitFor({ state: 'visible', timeout: 4000 }).catch(() => {
    throw new Error('Escape from browse should step back to the grid, not dismiss it');
  });
  console.log('  ok  Escape from browse steps back to the grid');

  // 4. The grid is still open — pick "other" → switches canvases and closes it.
  await page.locator('.canvas-grid-card[data-canvas="other"]').dispatchEvent('click');
  await page.waitForFunction(() => document.body.dataset.currentCanvas === 'other', { timeout: 6000 });
  await offScreen('Create').catch(() => { throw new Error('picking a canvas did not close the grid'); });
  console.log('  ok  picking a canvas switches to it and closes the grid');

  // 5. Re-open, then Escape closes the grid.
  await page.locator('#canvas-overview-toggle').dispatchEvent('click');
  await onScreen('Create').catch(() => { throw new Error('grid did not reopen'); });
  await page.keyboard.press('Escape');
  await offScreen('Create').catch(() => { throw new Error('Escape did not close the grid'); });
  // ...and the canvas Requirements button comes back once we're on one canvas.
  await page.locator('#canvas-reqs-toggle').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
    throw new Error('canvas Requirements button should return after the grid closes');
  });
  console.log('  ok  Escape closes the grid and the Requirements button returns');
};
