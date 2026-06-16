//
// probe-relationship-observe-toggle.mjs
//
// A relationship can read a target's current value and toggle it on an event.
// `phase` is a value/property on the phase component (settable via send,
// observable via on). `pulse` is an event the trigger emits on click. The
// trigger-to-phase relationship observes the current phase and writes back the
// opposite on each pulse — so pressing the button flips the readout A <-> B.
//
// The discriminating part: a relationship that ignored the target and just kept
// its own internal toggle would ALSO produce A,B,A on repeated pulses. To prove
// it actually reads the target, we change phase by a path the relationship does
// not drive (the component's own A/B buttons), then pulse: the result must be
// the flip of the EXTERNALLY-set value, not of the wire's stale guess.
//
// Asserts only on the on-screen readout, never on __io or any wiring internal.
//
// Run it:  node run-probe.mjs probe-relationship-observe-toggle.mjs
//

export const fixture = 'relationship-observe-toggle.liquidos';

const expect = (label, predicate, detail) => {
  if (predicate) { console.log('  ok  ' + label); return; }
  throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

const phaseIs = (page, v) => page.waitForFunction(
  want => document.querySelector('#phase-out')?.textContent === want, v, { timeout: 8000 });
const phaseText = page => page.evaluate(() => document.querySelector('#phase-out')?.textContent);

export default async ({ url, page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await phaseIs(page, 'A');
  expect('phase starts at A', (await phaseText(page)) === 'A');
  await page.waitForSelector('#trigger-btn', { timeout: 8000 });

  // A plain pulse flips the value.
  await page.locator('#trigger-btn').dispatchEvent('click');
  await phaseIs(page, 'B');
  expect('a pulse flips the phase A -> B', (await phaseText(page)) === 'B');

  // Now set phase from OUTSIDE the relationship, back to A. A wire that observes
  // the target sees this; one that kept its own toggle would still think it's B.
  await page.locator('#phase-set-a').dispatchEvent('click');
  await phaseIs(page, 'A');
  expect('the A button sets phase directly to A', (await phaseText(page)) === 'A');

  // The proof: pulse again. The relationship must read the current value (A) and
  // write its flip (B). A wire ignoring the target would flip its stale B -> A
  // and leave the readout at A. Seeing B proves the read of the target landed.
  await page.locator('#trigger-btn').dispatchEvent('click');
  await phaseIs(page, 'B');
  expect('after an external set, a pulse flips the OBSERVED value (A -> B), proving the read', (await phaseText(page)) === 'B');
};
