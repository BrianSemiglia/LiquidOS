//
// probe-relationship-peer-remount
//
// A relationship's connect() binds direct references to its peers' __io. When
// a PEER re-mounts — a canvas reload, or an edit to the peer's html/functions
// — it gets a brand-new __io and the relationship's subscription points at the
// dead one. The harness must re-wire the relationship; otherwise the wire
// silently dies until a full page reload.
//
// (The companion probe-relationship-live-reload covers the OTHER direction —
// the relationship's own code changing — which already re-mounts it.)
//
// Everything this probe checks is VISIBLE text. The source emits its
// generation ("gen N", shown on screen and bumped each mount); the relationship
// forwards it; the sink shows "received: gen N". So a press after the source
// re-mounts must make the sink echo the NEW generation — proof the wire
// followed the live peer. No private attributes.
//
// Run it:  node run-probe.mjs probe-relationship-peer-remount
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './workspace.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sees = (page, text) =>
    page.evaluate(t => (visibleText() || '').includes(t), text);
const seesText = (page, text, timeout) =>
    page.waitForFunction(t => (visibleText() || '').includes(t), text, { timeout });

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Source mounted → "gen 1" on screen, relationship connected.
    await seesText(page, 'gen 1', 20000)
        .catch(() => { throw new Error('source did not mount (no "gen 1" on screen)'); });
    await sleep(1000);

    const press = () => page.getByRole('button', { name: 'press' }).dispatchEvent('click');

    // 1. Baseline: pressing makes the sink echo the current generation.
    await press();
    await seesText(page, 'received: gen 1', 8000)
        .catch(() => { throw new Error('baseline failed: pressing did not echo "received: gen 1"'); });
    console.log('baseline: sink echoed gen 1');

    // 2. Re-mount the SOURCE peer by bumping its functions.js. It comes back as
    //    "gen 2" on screen — a fresh __io.
    const srcFns = path.join(workspace, 'home', 'components', 'source', 'functions.js');
    fs.writeFileSync(srcFns, fs.readFileSync(srcFns, 'utf8') + '\n// probe bump\n');
    console.log('--- bumped source/functions.js ---');
    await seesText(page, 'gen 2', 15000)
        .catch(() => { throw new Error('source did not re-mount (no "gen 2" on screen)'); });
    console.log('--- source re-mounted (gen 2) ---');

    // 3. Press the re-mounted source. Only a re-wired relationship will make
    //    the sink echo the NEW generation. Retry a few times to absorb the
    //    re-wire settling without racing it. Without the fix the sink never
    //    shows "received: gen 2".
    let ok = false;
    for (let i = 0; i < 15 && !ok; i++) {
        await press();
        await sleep(200);
        ok = await sees(page, 'received: gen 2');
    }
    if (!ok) {
        throw new Error('relationship did not re-wire after the source re-mounted — the sink never echoed the new generation');
    }
    console.log('after source re-mount: sink echoed gen 2 — relationship re-wired');
};
