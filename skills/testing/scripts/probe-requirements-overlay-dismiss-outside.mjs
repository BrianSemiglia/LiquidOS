//
// probe-requirements-overlay-dismiss-outside.mjs
//
// The requirements overlay dismisses on a click *outside* the live component
// and the requirements panel — not only on a pixel-perfect hit of the backdrop
// behind them. The overlay centers a fixed-size box (the live component on the
// left, the requirements editor on the right) that is larger than what it
// paints: the column gap between the two panes, and the empty area of the
// component's cell below its rendered surface, all look like "outside" to a
// user. A click there must close the editor.
//
// It must also NOT close when the click lands on the component or the panel —
// otherwise a too-eager "close on any click" would pass a naive test.
//
// Asserts only visible text: "Repair" (the recover affordance, shown only while
// the editor is open) is the open/closed sentinel; the component's own content
// proves it returned to the canvas. Coordinates are read from the two panes
// only to decide *where to click* (driving the app the way a user does), never
// to assert.
//
// Run it:  node run-probe.mjs probe-requirements-overlay-dismiss-outside.mjs
//

export const fixture = 'requirements-modal.liquidos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  page.on('pageerror', err => console.log('[pageerror]', err.message));

  const onScreen = (text, timeout = 6000) => page.waitForFunction(
    t => document.body.innerText.includes(t), text, { timeout });
  const offScreen = (text, timeout = 6000) => page.waitForFunction(
    t => !document.body.innerText.includes(t), text, { timeout });
  const visible = text => page.evaluate(t => document.body.innerText.includes(t), text);

  const WIDGET = 'A component with some content to render inside the requirements modal';
  const openModal = () => page.getByRole('button', { name: 'Edit Widget requirements' }).dispatchEvent('click');

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await onScreen(WIDGET, 20000);
  await sleep(800);

  // Open the editor. "Repair" (the recover affordance for the missing
  // requirements file) is on screen only while the editor is open.
  await openModal();
  await onScreen('Repair').catch(() => {
    throw new Error('the requirements editor did not open ("Repair" never appeared)');
  });

  // --- Guard 1: clicking the requirements panel must NOT dismiss. Click the
  //     panel header (the textarea is covered by the "Repair" recover button).
  await page.locator('.requirements-overlay .component-back-header').first().click();
  await sleep(300);
  if (!(await visible('Repair'))) {
    throw new Error('clicking inside the requirements panel wrongly dismissed the editor');
  }

  // --- Guard 2: clicking the live component must NOT dismiss.
  await page.locator('.requirements-overlay .surface').first().click({ position: { x: 8, y: 8 } });
  await sleep(300);
  if (!(await visible('Repair'))) {
    throw new Error('clicking the live component wrongly dismissed the editor');
  }

  // --- The fix: clicking the gap between the two panes (inside the centered
  //     box, but on neither the component nor the panel) must dismiss.
  const gap = await page.evaluate(() => {
    const surface = document.querySelector('.requirements-overlay .surface');
    const panel = document.querySelector('.requirements-overlay .component-back');
    if (!surface || !panel) return null;
    const s = surface.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    // Midpoint of the column gap, vertically centered on the panel.
    return { x: (s.right + p.left) / 2, y: (p.top + p.bottom) / 2 };
  });
  if (!gap) throw new Error('could not locate the gap between the component and the panel');
  await page.mouse.click(gap.x, gap.y);

  await offScreen('Repair').catch(() => {
    throw new Error('clicking outside the component and panel did not dismiss the editor ("Repair" still on screen)');
  });
  // The component is back on the canvas.
  if (!(await visible(WIDGET))) {
    throw new Error('the component did not return to the canvas after dismissal');
  }
};
