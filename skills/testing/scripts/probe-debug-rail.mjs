//
// probe-debug-rail.mjs
//
// Drag the #debug-resizer handle to a new x position; the harness's pointer
// handler updates the --debug-rail-width CSS variable. Probe asserts the
// variable's value changed, and that it persists in localStorage (the harness
// writes there for next-launch restore).
//
// Run it:  node run-probe.mjs probe-debug-rail.mjs
//

export const fixture = './probe-debug-rail.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const readRailWidth = (page) => page.evaluate(() =>
  getComputedStyle(document.body).getPropertyValue('--debug-rail-width').trim());

export default async ({ url, page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  page.on('pageerror', err => console.log('[page error]', err.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Debug rail is hidden by default; open it before exercising resize.
  await page.waitForFunction(() => typeof window.liquidos?.setDebugOpen === 'function', { timeout: 10000 });
  await page.evaluate(() => window.liquidos.setDebugOpen(true));
  await page.waitForSelector('#debug-resizer', { timeout: 10000 });
  await sleep(800);

  const before = await readRailWidth(page);
  console.log('rail width before drag:', before);

  // Use real pointer events — the handler listens for pointerdown + pointermove
  // + pointerup with setPointerCapture.
  const handle = page.locator('#debug-resizer');
  const box = await handle.boundingBox();
  if (!box) throw new Error('could not measure #debug-resizer bounding box');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  // Drag to a substantially different position; the harness clamps to
  // 240 .. 55% viewport, which keeps this visible.
  const targetX = 600;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(targetX, startY, { steps: 5 });
  await page.mouse.up();
  await sleep(300);

  const after = await readRailWidth(page);
  console.log('rail width after drag :', after);
  if (after === before) throw new Error('--debug-rail-width did not change after drag');

  // The harness persists width in localStorage.
  const persisted = await page.evaluate(() => localStorage.getItem('live-edit-debug-rail-width'));
  console.log('localStorage persisted:', persisted);
  if (!persisted || persisted.trim() === '') throw new Error('rail width was not persisted to localStorage');
};
