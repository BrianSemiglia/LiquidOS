//
// probe-canvas-delete-agent
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
// Run it:  node run-probe.mjs probe-canvas-delete-agent
//

import { execFileSync } from 'node:child_process';

export const fixture = './workspace.liquidos';
export const agent = './agent.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The workspace git log is the durable timeline recentEvents() reads to decide
// what happened; a deletion that skips its commit would still pass the on-screen
// checks. Assert the event landed in git — same record whether ✕ or agent drove it.
const gitLog = workspace => execFileSync('git', ['log', '--format=%B'], { cwd: workspace, encoding: 'utf8' });

export default async ({ url, workspace, page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  const onScreen = (text, timeout = 8000) => page.waitForFunction(
    t => visibleText().includes(t), text, { timeout });
  const offScreen = (text, timeout = 15000) => page.waitForFunction(
    t => !visibleText().includes(t), text, { timeout });

  const spaces = page.getByRole('button', { name: 'Show all spaces' });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await spaces.waitFor({ timeout: 20000 });
  await sleep(1000);

  // Pre-condition: the grid lists both canvases.
  await spaces.dispatchEvent('click');
  await onScreen('doomed').catch(() => { throw new Error('grid did not list the "doomed" canvas'); });
  await onScreen('home').catch(() => { throw new Error('grid did not list the "home" canvas'); });
  console.log('  ok  grid lists both "home" and "doomed"');
  // Close the grid before prompting so the submit lands cleanly on the bar.
  await page.keyboard.press('Escape');
  await offScreen('Create', 6000).catch(() => { throw new Error('Escape did not close the grid'); });

  // Prompt the agent → stub deletes the 'doomed' canvas via the shared CLI.
  await page.getByRole('textbox', { name: 'Prompt' }).fill('delete the doomed canvas');
  await page.getByRole('button', { name: 'Send' }).click();

  // Re-open the grid and watch the deleted canvas drop out (the grid live-
  // refreshes on canvases-changed), while the survivor stays.
  await spaces.dispatchEvent('click');
  await offScreen('doomed').catch(() => { throw new Error('agent delete did not remove "doomed" from the grid'); });
  await onScreen('home').catch(() => { throw new Error('agent delete should not have removed "home"'); });
  console.log('  ok  the agent deletes "doomed" and leaves "home"');

  // Reload: a real (committed) deletion is still gone. The grid view persists
  // across the reload, so the surviving cards are already shown — "home" stays
  // (its card is back on screen), "doomed" does not.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByRole('button', { name: 'Open home space' }).waitFor({ timeout: 20000 })
    .catch(() => { throw new Error('"home" missing after reload'); });
  await offScreen('doomed').catch(() => { throw new Error('"doomed" came back after reload — agent deletion did not persist'); });
  console.log('  ok  the agent deletion persists across a reload');

  // The deletion is bracketed in the workspace git timeline: a "will delete"
  // commit snapshots the canvas's final state BEFORE removal (so it's
  // recoverable), then a "did delete" commit records the removal. git log is
  // newest-first, so the "did" event sits above the older "will" event.
  const log = gitLog(workspace);
  const willAt = log.indexOf("User will delete canvas with name 'doomed'");
  const didAt = log.indexOf("User did delete canvas with name 'doomed'");
  if (willAt === -1) throw new Error('no "will delete" snapshot committed before the agent deletion');
  if (didAt === -1) throw new Error('agent deletion was not committed to the workspace git timeline');
  if (didAt > willAt) throw new Error('"will delete" must be committed before "did delete"');
  console.log('  ok  the agent deletion is bracketed (will → did) in the workspace git timeline');
};
