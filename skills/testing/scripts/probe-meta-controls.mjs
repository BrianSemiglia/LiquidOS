//
// probe-meta-controls.mjs
//
// The prompt bar is the master switch for the "meta controls":
//   - Each component's "Requirements" button is visible while the prompt bar
//     is up and gone when Escape hides it (a fully clean canvas).
//   - A top-right canvas "Requirements" button opens the canvas requirements
//     editor as a panel docked beside the canvas, and rides with the prompt
//     bar the same way. Escape closes the panel.
//
// Asserts visible text coming and going — the buttons' "Requirements" label and
// the docked editor's "Build" action — never geometry or flags.
//
// Run it:  node run-probe.mjs probe-meta-controls.mjs
//

export const fixture = './probe-meta-controls.liquidos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  page.on('pageerror', err => console.log('[pageerror]', err.message));

  const onScreen = (text, timeout = 6000) => page.waitForFunction(
    t => visibleText().includes(t), text, { timeout });
  const offScreen = (text, timeout = 6000) => page.waitForFunction(
    t => !visibleText().includes(t), text, { timeout });

  const WIDGET = 'A component with some content to render inside the requirements modal';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await onScreen(WIDGET, 20000);
  await sleep(500);

  // 1. Prompt bar up → meta controls visible: the component's Requirements
  //    button and the top-right canvas Requirements button both read
  //    "Requirements".
  await onScreen('Requirements').catch(() => {
    throw new Error('meta controls ("Requirements") not visible while the prompt bar is up');
  });

  // 2. Escape hides the prompt bar → every meta control goes with it.
  await page.keyboard.press('Escape');
  // The prompt bar's Send control is a glyph button ("↑") — its presence on
  // screen is the prompt bar being up.
  await offScreen('↑').catch(() => { throw new Error('prompt bar did not hide on Escape'); });
  await offScreen('Requirements').catch(() => {
    throw new Error('meta controls still visible after the prompt bar was hidden');
  });

  // 3. Escape again restores the prompt bar and the meta controls.
  await page.keyboard.press('Escape');
  await onScreen('↑').catch(() => { throw new Error('prompt bar did not return on Escape'); });
  await onScreen('Requirements').catch(() => { throw new Error('meta controls did not return with the prompt bar'); });

  // 4. The top-right canvas button docks the requirements panel beside the
  //    canvas — the canvas content stays on screen next to it.
  await page.getByRole('button', { name: 'Edit canvas requirements' }).click();
  await onScreen('Build').catch(() => {
    throw new Error('clicking the canvas Requirements button did not open the docked panel');
  });
  const widgetStillThere = await page.evaluate(t => visibleText().includes(t), WIDGET);
  if (!widgetStillThere) throw new Error('canvas content vanished when the requirements panel docked (should sit beside it)');

  // 4b. Focused mode: opening the panel hides the other meta controls — the
  //     prompt bar (its "↑" Send glyph) goes away while the editor is up.
  await offScreen('↑').catch(() => {
    throw new Error('prompt bar still visible while the canvas requirements panel was open');
  });

  // 5. Escape closes the docked panel and the meta controls come back.
  await page.keyboard.press('Escape');
  await offScreen('Build').catch(() => {
    throw new Error('Escape did not close the docked canvas requirements panel');
  });
  await onScreen('↑').catch(() => { throw new Error('prompt bar should return after closing the panel'); });
};
