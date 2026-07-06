//
// probe-relationship-failure-surfaces-on-sender
//
// When a relationship's mount or connect fails, the user has to know
// something's wrong — they can't see the relationship itself (it has no
// UI), but they can see its sender. Convention: a relationship folder
// named "<sender>-to-<receiver>" is owned, from the user's perspective,
// by the sender component. A failure in the relationship shows up as a
// Repair button on the sender.
//
// The probe:
//   1. Boots the relationship-reload fixture (source → sink, working).
//   2. Asserts: no Repair button visible anywhere on screen.
//   3. Breaks the relationship by rewriting its functions.js so mount()
//      throws.
//   4. Asserts: "Repair" appears on screen (attributed to the sender).
//   5. Asserts: only ONE Repair button is visible — the sink (receiver)
//      does not grow its own Repair.
//
// Run it:  node run-probe.mjs probe-relationship-failure-surfaces-on-sender
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './workspace.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
  page.on('pageerror', err => console.log('[page error]', err.message));

  const onScreen = (text, timeout = 8000) => page.waitForFunction(
    t => visibleText().includes(t), text, { timeout });
  const offScreen = (text, timeout = 8000) => page.waitForFunction(
    t => !visibleText().includes(t), text, { timeout });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for both components' visible text to confirm the canvas rendered.
  await onScreen('Press', 20000);
  await onScreen('nothing yet', 5000);
  // Give the relationship a chance to mount + connect cleanly.
  await sleep(2000);

  // --- Step 1: working relationship → no Repair button on screen ----------
  const hasRepair = await page.evaluate(
    () => visibleText().includes('Repair')
  );
  if (hasRepair) {
    throw new Error('source already shows Repair before any failure');
  }
  console.log('initial: source + sink both clean (no Repair on screen)');

  // --- Step 2: break the relationship ---------------------------------
  const fnPath = path.join(
    workspace,
    'home/relationships/source-to-sink/functions.js'
  );
  fs.writeFileSync(fnPath, `
export const mount = () => {
    throw new Error('SIMULATED_RELATIONSHIP_FAILURE');
};
`);
  console.log('relationship broken — waiting for sender Repair to surface...');

  // --- Step 3: source's Repair must surface on screen -------------------
  // The runtime repair button starts hidden (display:none); when the harness
  // attributes the throw to the sender, it un-hides it so "Repair" appears
  // in visibleText().
  await onScreen('Repair', 15000).catch(() => {
    throw new Error('source Repair never surfaced on screen after relationship broke');
  });
  console.log('source: Repair surfaced (relationship failure attributed to sender)');

  // --- Step 4: sink must NOT show Repair (it's the receiver) ------------
  // If the receiver incorrectly claims ownership the user sees two Repair
  // buttons. Count occurrences of "Repair" in the visible text — more than
  // one means the sink has also un-hidden its repair button.
  const repairCount = await page.evaluate(
    () => (visibleText().match(/Repair/g) || []).length
  );
  if (repairCount > 1) {
    throw new Error('sink showed Repair too — receiver must not claim relationship ownership (' + repairCount + ' Repair buttons visible)');
  }
  console.log('sink: clean (receiver does not claim ownership)');
};
