//
// probe-service-region-ownership.mjs
//
// Component A runs a service that patches its own region (#a-own) and also
// tries to patch component B's region (#b-guarded). B has no service. A
// service is confined to its own component, so:
//   - A's own-region patches land (proves the service is live), and
//   - A's patches to B's region are rejected — #b-guarded keeps only its
//     own content.
//
// Asserts only on rendered DOM. If services were not confined to their
// component, B's region would show A's INTRUDER text and the probe fails.
//
// Run it:  node run-probe.mjs probe-service-region-ownership.mjs
//

export const fixture = 'service-region-ownership.liquidos';

const expect = (label, predicate, detail) => {
  if (predicate) { console.log('  ok  ' + label); return; }
  throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Both regions render their initial content.
  await page.waitForFunction(() =>
    document.querySelector('#a-own')?.textContent?.includes('INIT_OWN') &&
    document.querySelector('#b-guarded')?.textContent?.includes('INIT_B'),
    undefined, { timeout: 10000 });

  // Wait until A's service has run several ticks (its own region keeps
  // updating). By OWN_3, A has also fired three patches AT B's region.
  await page.waitForFunction(() =>
    /OWN_3/.test(document.querySelector('#a-own')?.textContent || ''),
    undefined, { timeout: 8000 });

  const own = await page.evaluate(() => document.querySelector('#a-own')?.textContent || '');
  const guarded = await page.evaluate(() => document.querySelector('#b-guarded')?.textContent || '');

  expect("A's service patches its own region",
    /OWN_\d+/.test(own),
    'a-own: ' + JSON.stringify(own));

  // The discriminator: A's attempts to patch B's region are rejected.
  expect("A's service did NOT write into B's region",
    !guarded.includes('INTRUDER'),
    'b-guarded: ' + JSON.stringify(guarded));

  expect("B's region still holds its own content",
    guarded.includes('INIT_B'),
    'b-guarded: ' + JSON.stringify(guarded));
};
