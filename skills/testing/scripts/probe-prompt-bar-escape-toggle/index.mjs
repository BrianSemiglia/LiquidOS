//
// probe-prompt-bar-escape-toggle
//
// Escape owns the prompt bar: with nothing else open, pressing Escape hides
// the bar (the canvas gets the full viewport) and pressing Escape again brings
// it back. Asserts the bar's own visible text ("Send") coming and going —
// not its geometry or the data-prompt-hidden flag.
//
// Run it:  node run-probe.mjs probe-prompt-bar-escape-toggle
//

export const fixture = './workspace.liquidos';

export default async ({ url, page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));

  const onScreen = (text, timeout = 6000) => page.waitForFunction(
    t => visibleText().includes(t), text, { timeout });
  const offScreen = (text, timeout = 6000) => page.waitForFunction(
    t => !visibleText().includes(t), text, { timeout });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });

  // The prompt bar is on screen to start. Its Send control is a glyph button
  // ("↑"), so that's the visible string we track.
  await onScreen('↑').catch(() => { throw new Error('prompt bar ("↑" Send) not visible on load'); });

  // Escape hides it — the bar slides out and leaves the rendered tree.
  await page.keyboard.press('Escape');
  await offScreen('↑').catch(() => { throw new Error('Escape did not hide the prompt bar ("↑" still visible)'); });

  // Escape again brings it back.
  await page.keyboard.press('Escape');
  await onScreen('↑').catch(() => { throw new Error('Escape did not bring the prompt bar back ("↑" never returned)'); });

  // A held Escape auto-repeats keydown, and the repeat must NOT toggle the bar
  // — one action per physical press. From shown, hold Escape: a second
  // consecutive keydown carries repeat:true (the OS's auto-repeat). The first
  // keydown (repeat:false) hides the bar; the repeat must be ignored, so it
  // stays hidden. Without the guard the repeat reveals it again.
  //
  // Asserting "stays hidden" is robust against the slide-out animation: "↑"
  // only leaves the page once the slide finishes (visibility flips at the end).
  // The guarded case completes the slide and drops "↑"; the buggy case
  // interrupts the slide with a re-reveal, so "↑" never leaves — which is
  // exactly the failure offScreen catches.
  await page.keyboard.down('Escape');   // first keydown (repeat:false) → hides
  await page.keyboard.down('Escape');   // auto-repeat (repeat:true) → must be ignored
  await page.keyboard.up('Escape');
  await offScreen('↑').catch(() => { throw new Error('a held (repeated) Escape revealed the prompt bar again — the repeat keydown must be ignored'); });
};
