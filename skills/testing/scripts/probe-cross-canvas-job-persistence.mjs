//
// probe-cross-canvas-job-persistence.mjs
//
// Locks in the queue-survives-canvas-switch invariant.
//
// Setup: workspace with two canvases (home, other), each with a
// probe-built component pre-staged but not in input.json. Booted with
// the cross-canvas-persistence-test agent — its run() sleeps 2 seconds
// before writing input.json so the job is still in flight while the
// user navigates.
//
// Flow:
//   1. On home, submit a prompt through the bottom prompt bar. The
//      server enqueues a job scoped to home, dispatch fires, the agent
//      starts thinking (2s delay).
//   2. Immediately switch to other via the canvas-select dropdown.
//      Pre-fix, setCanvasPath would reset the queue here — wiping the
//      pending job before it could complete.
//   3. Wait long enough for the agent to finish (~3s).
//   4. Switch back to home.
//   5. Assert the agent's writes landed: home's input.json now
//      references probe-built, and the home marker is in the DOM.
//
// While on other, also assert that probe-built is NOT visible there —
// the agent's work belongs to home, not whichever canvas happened to
// be active at the time the job completed.
//
// Run it:  node run-probe.mjs probe-cross-canvas-job-persistence.mjs
//

export const fixture = 'cross-canvas-persistence.liquidos';
export const agent = 'cross-canvas-persistence-test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#global-text', { timeout: 20000 });
    await page.waitForFunction(
        () => document.getElementById('canvas-select')?.value === 'home',
        undefined,
        { timeout: 10000 }
    );
    await sleep(500);

    if (await page.locator('[data-cross-canvas-built]').count() !== 0) {
        throw new Error('marker existed before prompt-bar submit');
    }

    // --- 1. Dispatch from home -------------------------------------------
    await page.locator('#global-text').fill('Build it.');
    await page.evaluate(() => document.getElementById('global-prompt').requestSubmit());
    console.log('home: prompt submitted');

    // --- 2. Switch to other while the agent is still thinking ------------
    await page.selectOption('#canvas-select', 'other');
    await page.waitForFunction(
        () => document.getElementById('canvas-select')?.value === 'other',
        undefined,
        { timeout: 5000 }
    );
    console.log('switched to other');

    // Other should be empty — the agent's work is for home.
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('main .item')).length === 0,
        undefined,
        { timeout: 5000 }
    );

    // --- 3. Wait past the agent's 2s delay + propagation -----------------
    await sleep(3000);

    // While still on other, probe-built must NOT have appeared here
    // (the agent's input.json write was for home, not other).
    const builtOnOther = await page.evaluate(
        () => !!document.querySelector('[data-cross-canvas-built="other"]')
    );
    if (builtOnOther) {
        throw new Error('OTHER BUILT marker appeared on the wrong canvas — the agent wrote against the active canvas instead of its job scope');
    }
    console.log('other: probe-built correctly absent');

    // --- 4. Switch back to home ------------------------------------------
    await page.selectOption('#canvas-select', 'home');
    await page.waitForFunction(
        () => document.getElementById('canvas-select')?.value === 'home',
        undefined,
        { timeout: 5000 }
    );

    // --- 5. The agent's write to home must be there ----------------------
    await page.waitForSelector('[data-cross-canvas-built="home"]', { timeout: 10000 });
    const markerText = (await page.locator('[data-cross-canvas-built="home"]').textContent() || '').trim();
    if (markerText !== 'HOME BUILT') {
        throw new Error('home marker text was not "HOME BUILT": ' + JSON.stringify(markerText));
    }
    console.log('home: agent\'s work survived the canvas round-trip');
};
