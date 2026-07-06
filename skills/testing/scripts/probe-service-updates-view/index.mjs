//
// probe-service-updates-view
//
// A run-mode <liquidos-file> spawns service.js, which writes successive
// component.html values on a timer. The probe watches the rendered DOM and
// asserts it observes multiple SERVICE_STEP_<n> markers — that the
// service's writes reach the live view on screen.
//
// Run it:  node run-probe.mjs probe-service-updates-view
//

export const fixture = './workspace.liquidos';

const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Collect every distinct marker text the live DOM cycles through
    // while the service is writing. We sample for a few seconds; the
    // service writes ~4 times per second, so several steps should
    // appear.
    const observed = new Set();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
        const marker = await page.evaluate(() =>
            document.querySelector('[data-marker]')?.textContent || '');
        if (marker && marker.startsWith('SERVICE_STEP_')) observed.add(marker);
        await new Promise(r => setTimeout(r, 100));
    }

    expect('observed at least three distinct service writes in the rendered view',
        observed.size >= 3,
        'distinct markers seen: ' + JSON.stringify([...observed]));
};
