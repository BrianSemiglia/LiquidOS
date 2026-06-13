//
// probe-region-contention.mjs
//
// Two co-owning services stream exclusive replace patches at the same
// #shared region. X opens its replace stream first and holds it; Y keeps
// firing replaces at the same region. Only one producer may own a region
// at a time, so X must keep it and Y_INTRUDER must NEVER reach the view.
//
// A MutationObserver records every value #shared ever holds, so a single
// clobbered frame is caught. Without contention handling Y's replaces
// clobber X mid-stream and Y_INTRUDER shows up; with a per-region lease it
// never does. Asserts only on rendered DOM.
//
// Run it:  node run-probe.mjs probe-region-contention.mjs
//

export const fixture = 'region-contention.liquidos';

const expect = (label, predicate, detail) => {
  if (predicate) { console.log('  ok  ' + label); return; }
  throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Record every value #shared takes, including transient frames.
  await page.waitForFunction(() => !!document.querySelector('#shared'), undefined, { timeout: 10000 });
  await page.evaluate(() => {
    window.__sharedHistory = [];
    const el = document.querySelector('#shared');
    const rec = () => window.__sharedHistory.push(el.textContent);
    rec();
    new MutationObserver(rec).observe(el, { childList: true, characterData: true, subtree: true });
  });

  // X wins the region and streams into it.
  await page.waitForFunction(() =>
    /X\d/.test(document.querySelector('#shared')?.textContent || ''),
    undefined, { timeout: 8000 });

  // Let Y run against the held region for a couple of seconds.
  await new Promise(r => setTimeout(r, 2500));

  const history = await page.evaluate(() => window.__sharedHistory || []);
  const sawX = history.some(v => /X\d/.test(v));
  const sawIntruder = history.some(v => v.includes('Y_INTRUDER'));

  expect("X owns the region and streams into it",
    sawX, 'no X frames recorded');

  // The discriminator: the loser never reaches the view, not even for one
  // frame.
  expect("Y never clobbered the region X holds (no Y_INTRUDER frame)",
    !sawIntruder,
    'frames containing intruder: ' + JSON.stringify(history.filter(v => v.includes('Y_INTRUDER')).slice(0, 5)));
};
