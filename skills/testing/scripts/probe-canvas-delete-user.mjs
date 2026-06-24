//
// probe-canvas-delete-user.mjs
//
// User zooms out to the canvas grid → each card carries the agent-cancel "✕"
// → clicking the ✕ on a canvas deletes it. The deleted canvas's name leaves
// the grid, the survivor stays, and a reload proves the deletion stuck (the
// folder is really gone, not just hidden). UI-only; no agent involved — this
// is the picker's own DELETE /canvases/<name> path.
//
// Asserts visible strings (canvas names coming and going) — never flags,
// classes, or disk.
//
// Run it:  node run-probe.mjs probe-canvas-delete-user.mjs
//

import { execFileSync } from 'node:child_process';

export const fixture = './probe-canvas-delete-user.liquidos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The workspace git log is the durable timeline recentEvents() reads to decide
// what happened; a deletion that skips its commit would still pass the on-screen
// checks. Assert the event landed in git.
const gitLog = workspace => execFileSync('git', ['log', '--format=%B'], { cwd: workspace, encoding: 'utf8' });

export default async ({ url, workspace, page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  const onScreen = (text, timeout = 8000) => page.waitForFunction(
    t => document.body.innerText.includes(t), text, { timeout });
  const offScreen = (text, timeout = 8000) => page.waitForFunction(
    t => !document.body.innerText.includes(t), text, { timeout });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#canvas-overview-toggle', { timeout: 20000 });
  await sleep(1000);

  // Zoom out → the grid lists both canvases.
  await page.locator('#canvas-overview-toggle').dispatchEvent('click');
  await onScreen('doomed').catch(() => { throw new Error('grid did not list the "doomed" canvas'); });
  await onScreen('home').catch(() => { throw new Error('grid did not list the "home" canvas'); });
  console.log('  ok  grid lists both "home" and "doomed"');

  // Click the ✕ on the "doomed" card, located by its accessible name (the
  // way a person/AT identifies a text-less icon button) rather than a CSS
  // class. dispatchEvent bypasses the reveal-on-hover styling.
  await page.getByRole('button', { name: 'Delete canvas doomed', exact: true })
    .dispatchEvent('click');

  // The card's name leaves the grid, and the survivor stays put.
  await offScreen('doomed').catch(() => { throw new Error('deleting "doomed" did not remove it from the grid'); });
  await onScreen('home').catch(() => { throw new Error('deleting "doomed" should not have removed "home"'); });
  console.log('  ok  the ✕ deletes "doomed" and leaves "home"');

  // Reload and re-open the grid: a real (committed) deletion is still gone;
  // a merely-hidden card would come back.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#canvas-overview-toggle', { timeout: 20000 });
  await sleep(1000);
  await page.locator('#canvas-overview-toggle').dispatchEvent('click');
  await onScreen('home').catch(() => { throw new Error('"home" missing after reload'); });
  await offScreen('doomed').catch(() => { throw new Error('"doomed" came back after reload — deletion did not persist'); });
  console.log('  ok  the deletion persists across a reload');

  // The deletion is bracketed in the workspace git timeline: a "will delete"
  // commit snapshots the canvas's final state BEFORE removal (so it's
  // recoverable), then a "did delete" commit records the removal. git log is
  // newest-first, so the "did" event sits above the older "will" event.
  const log = gitLog(workspace);
  const willAt = log.indexOf("User will delete canvas with name 'doomed'");
  const didAt = log.indexOf("User did delete canvas with name 'doomed'");
  if (willAt === -1) throw new Error('no "will delete" snapshot committed before the deletion');
  if (didAt === -1) throw new Error('deletion was not committed to the workspace git timeline');
  if (didAt > willAt) throw new Error('"will delete" must be committed before "did delete"');
  console.log('  ok  the deletion is bracketed (will → did) in the workspace git timeline');
};
