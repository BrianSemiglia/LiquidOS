//
// probe-canvas-delete-agent.mjs
//
// The agent path for deleting a canvas. User prompts the agent; the stub agent
// runs the shared canvas/delete-canvas.js CLI (the same tool delete-instance.sh
// wraps) against the pre-staged 'doomed' canvas. The workspace watcher fires
// canvases-changed, so the grid drops the card — the deleted canvas's name
// leaves the grid, the survivor stays, and a reload proves it stuck.
//
// Mirror of probe-canvas-delete-user.mjs through the agent instead of the ✕
// button: both paths must produce the same visible outcome.
//
// Run it:  node run-probe.mjs probe-canvas-delete-agent.mjs
//

export const fixture = './probe-canvas-delete-agent.liquidos';
export const agent = 'agent/test/canvas-delete-test-agent.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  const onScreen = (text, timeout = 8000) => page.waitForFunction(
    t => document.body.innerText.includes(t), text, { timeout });
  const offScreen = (text, timeout = 15000) => page.waitForFunction(
    t => !document.body.innerText.includes(t), text, { timeout });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#canvas-overview-toggle', { timeout: 20000 });
  await sleep(1000);

  // Pre-condition: the grid lists both canvases.
  await page.locator('#canvas-overview-toggle').dispatchEvent('click');
  await onScreen('doomed').catch(() => { throw new Error('grid did not list the "doomed" canvas'); });
  await onScreen('home').catch(() => { throw new Error('grid did not list the "home" canvas'); });
  console.log('  ok  grid lists both "home" and "doomed"');
  // Close the grid before prompting so the submit lands cleanly on the bar.
  await page.keyboard.press('Escape');
  await offScreen('Create', 6000).catch(() => { throw new Error('Escape did not close the grid'); });

  // Prompt the agent → stub deletes the 'doomed' canvas via the shared CLI.
  await page.locator('#global-text').fill('delete the doomed canvas');
  await page.locator('#global-prompt button[type="submit"]').click();

  // Re-open the grid and watch the deleted canvas drop out (the grid live-
  // refreshes on canvases-changed), while the survivor stays.
  await page.locator('#canvas-overview-toggle').dispatchEvent('click');
  await offScreen('doomed').catch(() => { throw new Error('agent delete did not remove "doomed" from the grid'); });
  await onScreen('home').catch(() => { throw new Error('agent delete should not have removed "home"'); });
  console.log('  ok  the agent deletes "doomed" and leaves "home"');

  // Reload and re-open: a real (committed) deletion is still gone.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#canvas-overview-toggle', { timeout: 20000 });
  await sleep(1000);
  await page.locator('#canvas-overview-toggle').dispatchEvent('click');
  await onScreen('home').catch(() => { throw new Error('"home" missing after reload'); });
  await offScreen('doomed').catch(() => { throw new Error('"doomed" came back after reload — agent deletion did not persist'); });
  console.log('  ok  the agent deletion persists across a reload');
};
