//
// probe-relationship-reactive-wiring
//
// A canvas with a working source->sink relationship AND a plain bystander
// component that exposes no __io. The relationship must wire as soon as its
// own peers (source, sink) are present — it must NOT wait on the bystander.
//
// Today wireIO waits for EVERY component to expose __io before connecting any
// relationship, so the bystander (which never will) drives it to its retry
// limit and it logs "wireIO: timed out … missing surface.__io". With reactive,
// peer-scoped wiring there is nothing to wait for and no such warning.
//
// Asserts only on rendered DOM + console: the sink shows the forwarded value,
// and no wireIO-timeout warning is logged.
//
// Run it:  node run-probe.mjs probe-relationship-reactive-wiring
//

export const fixture = './workspace.liquidos';

const expect = (label, predicate, detail) => {
  if (predicate) { console.log('  ok  ' + label); return; }
  throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  const wireWarnings = [];
  page.on('console', m => {
    if (m.type() === 'warning' && /wireio.*timed out/i.test(m.text())) wireWarnings.push(m.text());
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // The relationship wires source -> sink; the sink paints the forwarded value.
  await page.waitForFunction(() =>
    document.querySelector('#sink-out')?.textContent === 'FROM_SOURCE',
    undefined, { timeout: 8000 });

  expect('relationship wired: sink shows the source value',
    (await page.evaluate(() => document.querySelector('#sink-out')?.textContent)) === 'FROM_SOURCE');

  // Give any (mistaken) timeout warning ample time to fire before asserting.
  await new Promise(r => setTimeout(r, 500));

  // The discriminator: the bystander (no __io, no relationship) must not have
  // held wiring hostage. Reactive wiring never waits on it; the old polling
  // does and logs a timeout.
  expect('no wireIO timeout warning (bystander did not block wiring)',
    wireWarnings.length === 0,
    'warnings: ' + JSON.stringify(wireWarnings));
};
