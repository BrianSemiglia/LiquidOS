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

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('liquidos-component[path="components/gizmo"]', { timeout: 20000 });

    // --- share ON via Canvas Info → Shared toggle -------------------------
    await page.locator('#canvas-info').click();
    await page.locator('#canvas-share-switch').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#canvas-share-switch').click();
    await page.waitForFunction(
        () => {
            const btn = document.getElementById('canvas-share-switch');
            return btn
                && btn.getAttribute('aria-checked') === 'true'
                && !btn.hasAttribute('disabled');
        },
        undefined,
        { timeout: 30000 }
    );
    await page.locator('#canvas-requirements-cancel').click();
    await page.waitForFunction(
        () => document.getElementById('canvas-requirements-overlay')?.hidden === true,
        undefined,
        { timeout: 5000 }
    );
    console.log('Shared ON');

    // --- own bundle appears in own Browse ---------------------------------
    await page.locator('#new-canvas').click();
    await page.waitForSelector('#browse-overlay:not([hidden])', { timeout: 5000 });
    await page.locator('#browse-query').fill('home');
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('#browse-results .browse-result'))
            .some(c => (c.querySelector('.browse-result-name')?.textContent || '').trim() === 'home'),
        undefined,
        { timeout: 10000 }
    );
    console.log('own bundle visible in own Browse');

    // --- share OFF via Canvas Info → Shared toggle ------------------------
    // Close Browse, reopen Canvas Info.
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.locator('#canvas-info').click();
    await page.locator('#canvas-share-switch').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#canvas-share-switch').click();
    await page.waitForFunction(
        () => {
            const btn = document.getElementById('canvas-share-switch');
            return btn
                && btn.getAttribute('aria-checked') === 'false'
                && !btn.hasAttribute('disabled');
        },
        undefined,
        { timeout: 30000 }
    );
    await page.locator('#canvas-requirements-cancel').click();
    await page.waitForFunction(
        () => document.getElementById('canvas-requirements-overlay')?.hidden === true,
        undefined,
        { timeout: 5000 }
    );
    console.log('Shared OFF');

    // --- own bundle gone from own Browse ----------------------------------
    await page.locator('#new-canvas').click();
    await page.waitForSelector('#browse-overlay:not([hidden])', { timeout: 5000 });
    await page.locator('#browse-query').fill('home');
    await sleep(500);
    const stillThere = await page.evaluate(
        () => Array.from(document.querySelectorAll('#browse-results .browse-result'))
            .some(c => (c.querySelector('.browse-result-name')?.textContent || '').trim() === 'home')
    );
    if (stillThere) throw new Error('own bundle still visible in own Browse after unshare');
    console.log('own bundle no longer in own Browse');
};
