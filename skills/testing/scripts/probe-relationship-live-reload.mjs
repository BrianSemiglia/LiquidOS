//
// probe-relationship-live-reload.mjs
//
// Verifies that when a relationship's functions.js is rewritten in place,
// the harness re-mounts the new code and the next user interaction shows
// the new behavior — without a page reload.
//
// The fixture has:
//   - a source component (a button that emits 'press')
//   - a sink component (a span whose text gets set on 'show')
//   - a relationship that wires source → sink, forwarding the press as
//     a 'show' message with payload "v1"
//
// The probe:
//   1. Loads the page, clicks the button, expects the sink to show "v1".
//   2. Rewrites the relationship's functions.js to send "v2" instead.
//   3. Clicks the button again, expects the sink to show "v2".
//
// Run it:  node run-probe.mjs probe-relationship-live-reload.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = 'relationship-reload.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
  page.on('pageerror', err => console.log('[page error]', err.message));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-source-btn]', { timeout: 20000 });
  await page.waitForSelector('[data-sink]', { timeout: 20000 });
  // Let the relationship mount and connect() run.
  await sleep(2000);

  const sinkText = () => page.locator('[data-sink]').textContent().then(s => s.trim());
  // dispatchEvent fires the click event directly on the button, bypassing
  // any harness chrome (flip-button overlay, etc.) that can intercept a
  // coordinate-based mouse click on a small fixture element. The press
  // event flow being tested is identical either way.
  const pressButton = () => page.locator('[data-source-btn]').dispatchEvent('click');

  // --- Step 1: initial behavior -------------------------------------
  await pressButton();
  await sleep(300);
  const afterFirst = await sinkText();
  console.log('after first press:', afterFirst);
  if (afterFirst !== 'v1') {
    throw new Error('initial press did not propagate');
  }

  // --- Step 2: rewrite the relationship's functions.js --------------
  const fnPath = path.join(
    workspace,
    'home/relationships/source-to-sink/functions.js'
  );
  const updated = `
// v2: forwards button presses to sink with the label "v2".
export const mount = (surface) => {
    let off = null;
    surface.__io = {
        peers: ['source', 'sink'],
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const src = peers['source'];
            const dst = peers['sink'];
            if (!src || !dst) return;
            off = src.on('press', () => dst.send('show', 'v2'));
        },
    };
    return () => { if (off) { try { off(); } catch {} ; off = null; } };
};
`;
  fs.writeFileSync(fnPath, updated);
  console.log('functions.js rewritten — waiting for harness to re-attach...');
  // Give the fs.watch → broadcast → /input refresh → re-mount cycle time.
  await sleep(2500);

  // --- Step 3: new behavior -----------------------------------------
  await pressButton();
  await sleep(300);
  const afterRewrite = await sinkText();
  console.log('after rewrite + press:', afterRewrite);
  if (afterRewrite !== 'v2') {
    throw new Error('rewrite did not re-attach');
  }
};
