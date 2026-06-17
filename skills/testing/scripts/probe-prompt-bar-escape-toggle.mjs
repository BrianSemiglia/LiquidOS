//
// probe-prompt-bar-escape-toggle.mjs
//
// Escape owns the prompt bar: with nothing else open, pressing Escape hides
// the bar (the canvas gets the full viewport) and pressing Escape again brings
// it back. Asserts the bar's own visible text ("Send") coming and going —
// not its geometry or the data-prompt-hidden flag.
//
// Run it:  node run-probe.mjs probe-prompt-bar-escape-toggle.mjs
//

export const fixture = 'canvas-empty-no-components.liquidos';

export default async ({ url, page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));

  const onScreen = (text, timeout = 6000) => page.waitForFunction(
    t => document.body.innerText.includes(t), text, { timeout });
  const offScreen = (text, timeout = 6000) => page.waitForFunction(
    t => !document.body.innerText.includes(t), text, { timeout });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#global-text', { timeout: 20000 });

  // The prompt bar is on screen to start.
  await onScreen('Send').catch(() => { throw new Error('prompt bar ("Send") not visible on load'); });

  // Escape hides it — the bar slides out and leaves the rendered tree.
  await page.keyboard.press('Escape');
  await offScreen('Send').catch(() => { throw new Error('Escape did not hide the prompt bar ("Send" still visible)'); });

  // Escape again brings it back.
  await page.keyboard.press('Escape');
  await onScreen('Send').catch(() => { throw new Error('Escape did not bring the prompt bar back ("Send" never returned)'); });
};
