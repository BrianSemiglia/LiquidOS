//
// probe-relationship-peer-remount.mjs
//
// A relationship's connect() binds direct references to its peers' __io
// (e.g. `off = src.on('press', ...)`). When a PEER re-mounts — a canvas
// reload, or an edit to the peer's html/functions — it gets a brand-new
// __io and the relationship's subscription points at the dead one. The
// harness must notice the peer was replaced and re-wire the relationship;
// otherwise the wire silently dies until a full page reload.
//
// (The companion probe-relationship-live-reload covers the OTHER direction —
// the relationship's own code changing — which already re-mounts the
// relationship and so was never affected by this bug.)
//
// Fixture: source button emits 'press', sink shows on 'show', relationship
// forwards press → show "v1". This probe:
//   1. Clicks the button, expects the sink to show "v1".
//   2. Rewrites the SOURCE's functions.js (a no-op bump) so the source
//      re-mounts with a fresh __io. Waits for data-mounts to reach 2.
//   3. Clears the sink, clicks again, expects "v1" to reappear — i.e. the
//      relationship re-wired to the new source. Without the fix it stays
//      empty.
//
// Run it:  node run-probe.mjs probe-relationship-peer-remount.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = 'relationship-peer-remount.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-source-btn]', { timeout: 20000 });
    await page.waitForSelector('[data-sink]', { timeout: 20000 });
    // Let the source/sink mount and the relationship connect().
    await sleep(2000);

    const sinkText = () => page.locator('[data-sink]').textContent().then(s => s.trim());
    const click = () => page.locator('[data-source-btn]').dispatchEvent('click');

    // 1. Baseline: the wire works.
    await click();
    await page.waitForFunction(() => document.querySelector('[data-sink]')?.textContent.trim() === 'v1', { timeout: 8000 })
        .catch(() => { throw new Error('baseline failed: clicking did not show "v1" before any re-mount'); });
    console.log('baseline: sink shows', JSON.stringify(await sinkText()));

    // 2. Re-mount the SOURCE peer by bumping its functions.js (a trivial
    //    comment). The source's <liquidos-file script> reloads → new __io.
    const srcFns = path.join(workspace, 'home', 'components', 'source', 'functions.js');
    fs.writeFileSync(srcFns, fs.readFileSync(srcFns, 'utf8') + '\n// probe bump ' + 'remount' + '\n');
    console.log('--- bumped source/functions.js ---');
    await page.waitForFunction(
        () => document.querySelector('[data-source-btn]')?.dataset.mounts === '2',
        { timeout: 15000 }
    ).catch(() => { throw new Error('source did not re-mount (data-mounts never reached 2)'); });
    console.log('--- source re-mounted (data-mounts=2) ---');

    // 3. Clear the sink, then click the (re-mounted) source. Only a re-wired
    //    relationship will repopulate it. Retry a few times to absorb the
    //    re-wire settling without racing it.
    await page.evaluate(() => { document.querySelector('[data-sink]').textContent = ''; });
    let ok = false;
    for (let i = 0; i < 15 && !ok; i++) {
        await click();
        await sleep(200);
        if ((await sinkText()) === 'v1') ok = true;
    }
    if (!ok) {
        throw new Error('relationship did not re-wire after the source re-mounted — clicking the new source left the sink empty (still "' + (await sinkText()) + '")');
    }
    console.log('after source re-mount: sink shows', JSON.stringify(await sinkText()), '— relationship re-wired');
};
