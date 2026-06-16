//
// probe-relationship-canvas-peer.mjs
//
// The canvas itself is an I/O peer. canvas.js attaches root.__io, so a
// component can wire to canvas-owned behavior that has no card of its own
// (camera, ambient environment, rain) through a normal relationship instead
// of an out-of-band shared file.
//
// The fixture: a `control` component publishes a value on click; the canvas
// exposes a `send('drive', …)` endpoint that paints a visible readout; a
// `control-to-canvas` relationship forwards control → canvas under the
// reserved peer name `canvas`. Pressing the control must change the canvas's
// readout — proving the wire reaches the canvas peer and carries live events.
//
// Asserts only on rendered DOM, never on internals.
//
// Run it:  node run-probe.mjs probe-relationship-canvas-peer.mjs
//

export const fixture = 'relationship-canvas-peer.liquidos';

const expect = (label, predicate, detail) => {
  if (predicate) { console.log('  ok  ' + label); return; }
  throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // The canvas paints its own readout before anything drives it.
  await page.waitForFunction(() =>
    document.querySelector('#canvas-out')?.textContent === 'CANVAS_EMPTY',
    undefined, { timeout: 8000 });
  expect('canvas readout starts empty',
    (await page.evaluate(() => document.querySelector('#canvas-out')?.textContent)) === 'CANVAS_EMPTY');

  // Press the control; the relationship forwards its value to the canvas peer.
  await page.waitForSelector('#control-btn', { timeout: 8000 });
  await page.locator('#control-btn').dispatchEvent('click');

  await page.waitForFunction(() =>
    document.querySelector('#canvas-out')?.textContent === 'DRIVEN_BY_CONTROL',
    undefined, { timeout: 8000 });
  expect('control drives the canvas readout through the relationship',
    (await page.evaluate(() => document.querySelector('#canvas-out')?.textContent)) === 'DRIVEN_BY_CONTROL');
};
