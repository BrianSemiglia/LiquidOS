//
// probe-concurrent-producers-no-corruption.mjs
//
// Two run-mode services patch the live view at the same time. Producer A
// holds a streaming patch for its own region open across a delay; producer
// B emits complete patches into that gap. The probe asserts each
// producer's text lands ONLY in its own region — A's stream completes
// cleanly in #a-status, B's tokens land in #b-status, and neither leaks
// into the other.
//
// If the two producers share a single parser, B's close tag ends A's open
// stream early: B's marker text contaminates #a-status and A's "_close"
// never lands. The waitForFunction for a clean A cycle then times out.
//
// Asserts only on rendered DOM — never on the channel or wire format.
//
// Run it:  node run-probe.mjs probe-concurrent-producers-no-corruption.mjs
//

export const fixture = 'concurrent-producers.liquidos';

const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Both components render their initial regions.
    await page.waitForFunction(() =>
        document.querySelector('#a-status')?.textContent?.includes('INIT_A') &&
        document.querySelector('#b-status')?.textContent?.includes('INIT_B'),
        undefined, { timeout: 10000 });

    // Run to steady state: by A's third cycle both producers have been
    // emitting concurrently through several of A's held-open windows, so a
    // shared parser has had ample chance to interleave them.
    await page.waitForFunction(() =>
        /A3_open/.test(document.querySelector('#a-status')?.textContent || ''),
        undefined, { timeout: 8000 });

    const a = await page.evaluate(() => document.querySelector('#a-status')?.textContent || '');
    const b = await page.evaluate(() => document.querySelector('#b-status')?.textContent || '');

    expect("producer A's own stream lands in its own region",
        /A\d+_open/.test(a),
        'a-status: ' + JSON.stringify(a));

    // The discriminator. Under a shared parser, B's markers that arrive
    // while A's stream is open are swallowed into #a-status (their text and
    // their target selector leak in). Under one parser per producer, A's
    // region can never contain B's bytes.
    expect("producer B's patches did NOT leak into A's region",
        !a.includes('B_') && !a.toLowerCase().includes('lqpatch') && !a.includes('#b-status'),
        'a-status: ' + JSON.stringify(a));

    expect("producer B's patches landed in B's own region",
        b.includes('B_'),
        'b-status: ' + JSON.stringify(b));
};
