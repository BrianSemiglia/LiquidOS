//
// probe-canvas-unshare.mjs
//
// Verifies the un-share half of the share toggle on the publisher side
// through the UI. After flipping Shared back off, the publisher's own
// Browse must stop showing the bundle (their local feed.json is the
// source of truth for their own bundles).
//
// Peer-side propagation isn't tested here — at the current
// PEER_FEED_REPOLL_INTERVAL_MS (~hours) it can't realistically be
// observed inside a test run.
//
// Run it:  node run-probe.mjs probe-canvas-unshare.mjs
//

export const fixture = 'canvas-switcher.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    const onScreen  = (text, timeout = 10000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });
    const offScreen = (text, timeout = 10000) => page.waitForFunction(
        t => !document.body.innerText.includes(t), text, { timeout });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for the fixture's component content to confirm the canvas loaded.
    await onScreen('Gizmo', 20000);

    // --- share ON via Canvas Info → Shared toggle -------------------------
    await page.locator('#canvas-reqs-toggle').click();
    await onScreen('Build').catch(() => {
        throw new Error('canvas requirements editor did not open');
    });
    await page.locator('#canvas-share-switch').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#canvas-share-switch').click();
    // Wait for the async toggle to settle (re-enables after the PUT resolves).
    await page.waitForFunction(
        () => {
            const btn = document.getElementById('canvas-share-switch');
            return btn && !btn.hasAttribute('disabled');
        },
        undefined,
        { timeout: 30000 }
    );
    await page.locator('#canvas-requirements-cancel').click();
    await offScreen('Build').catch(() => {
        throw new Error('canvas requirements editor did not close');
    });
    console.log('Shared ON');

    // --- own bundle appears in own Browse ---------------------------------
    // Browse is reached via the canvas grid's "+ New" card.
    await page.locator('#canvas-overview-toggle').dispatchEvent('click');
    await page.locator('#canvas-grid-new').dispatchEvent('click');
    await onScreen('Type to search', 5000);
    await page.locator('#browse-query').fill('home');
    // The bundle name "home" appears in the results list (input values are
    // not part of document.body.innerText, so this is the result row text).
    await onScreen('home', 10000).catch(() => {
        throw new Error('"home" bundle did not appear in own Browse after sharing ON');
    });
    console.log('own bundle visible in own Browse');

    // --- share OFF via Canvas Info → Shared toggle ------------------------
    // Close Browse, reopen Canvas Info. Escape steps back browse → grid; a
    // second Escape closes the grid back to the canvas so the canvas
    // Requirements button is available again.
    await page.keyboard.press('Escape');
    await sleep(150);
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.locator('#canvas-reqs-toggle').click();
    await onScreen('Build').catch(() => {
        throw new Error('canvas requirements editor did not reopen');
    });
    await page.locator('#canvas-share-switch').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#canvas-share-switch').click();
    // Wait for the async toggle to settle.
    await page.waitForFunction(
        () => {
            const btn = document.getElementById('canvas-share-switch');
            return btn && !btn.hasAttribute('disabled');
        },
        undefined,
        { timeout: 30000 }
    );
    await page.locator('#canvas-requirements-cancel').click();
    await offScreen('Build').catch(() => {
        throw new Error('canvas requirements editor did not close after share OFF');
    });
    console.log('Shared OFF');

    // --- own bundle gone from own Browse ----------------------------------
    // Browse is reached via the canvas grid's "+ New" card.
    await page.locator('#canvas-overview-toggle').dispatchEvent('click');
    await page.locator('#canvas-grid-new').dispatchEvent('click');
    await onScreen('Type to search', 5000);
    await page.locator('#browse-query').fill('home');
    await sleep(500); // let the debounce + search complete
    // After unshare the local feed has no "home" bundle, so the search
    // returns nothing and "No matches yet." appears.
    await onScreen('No matches yet.', 5000).catch(() => {
        throw new Error('own bundle still visible in own Browse after unshare — "No matches yet." never appeared');
    });
    console.log('own bundle no longer in own Browse');
};
