//
// probe-service-region-patch.mjs
//
// A run-mode service updates only the #status region of its view by
// printing to its stdout on a timer — the same view channel the agent
// patches through — instead of rewriting the whole view.json. This buys
// an observable benefit the whole-view (view.json) path cannot: a
// sibling the user is editing is left untouched while the region keeps
// updating.
//
// The probe types into the input, then watches the status region cycle
// through several service-driven steps, and asserts BOTH that the steps
// reached the live DOM AND that the typed text survived. It asserts only
// on rendered DOM — never on the wire format, the channel, or any
// internal selector the harness uses.
//
// Run it:  node run-probe.mjs probe-service-region-patch.mjs
//

export const fixture = 'service-region-patch.liquidos';

const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Baseline: the view renders its input and its WAITING status region.
    await page.waitForFunction(() =>
        document.querySelector('#user-note') &&
        document.querySelector('[data-marker]')?.textContent?.includes('WAITING'),
        undefined, { timeout: 10000 });

    // The user types into the input — live state the service must not
    // disturb when it updates the status region.
    const typed = 'HELLO_TYPED';
    await page.fill('#user-note', typed);

    // The service streams successive STEP_<n> tokens into the status
    // region. Seeing STEP_3 means several distinct service-driven updates
    // reached the live view (not just the first). This is the assertion
    // that fails until the service's output is routed to the view.
    await page.waitForFunction(() =>
        document.querySelector('[data-marker]')?.textContent?.includes('STEP_3'),
        undefined, { timeout: 8000 });

    const status = await page.evaluate(() =>
        document.querySelector('[data-marker]')?.textContent || '');
    expect('status region shows several service-driven steps',
        status.includes('STEP_1') && status.includes('STEP_3'),
        'status text: ' + JSON.stringify(status));

    // The whole point of a region patch: the user's typed text survives
    // while the sibling region keeps updating. A whole-view rewrite would
    // have wiped this.
    const surviving = await page.evaluate(() =>
        document.querySelector('#user-note')?.value || '');
    expect('typed input survives the service updates',
        surviving === typed,
        'input value after updates: ' + JSON.stringify(surviving));
};
