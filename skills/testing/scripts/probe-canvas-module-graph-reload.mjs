//
// probe-canvas-module-graph-reload.mjs
//
// A canvas's presentation is canvas.js plus the modules it imports, transitively
// (canvas.js -> a.js -> b.js here). Editing any of them must go live, and a file
// no module imports must not disturb anything — all driven by the actual import
// graph, with no extension or folder special-casing and no author-side ?v
// ceremony (canvas.js uses plain `import './a.js'`).
//
// Two directions, both asserted through the real UI:
//   * Edit b.js (two hops deep): the new value appears AND the canvas re-mounts
//     (mount counter climbs) — proving the deep dependency is tracked and the
//     whole subtree re-fetches fresh (no stale transitive import).
//   * Edit unused.js (imported by nobody): nothing changes and the canvas does
//     NOT re-mount — proving reloads follow the closure, not "any .js in the
//     folder".
//
// Run it:  node run-probe.mjs probe-canvas-module-graph-reload.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './probe-canvas-module-graph-reload.liquidos';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The canvas paints its mount number on screen ("HOUSE-LEFT #1"). Read it the way
// a user does — off the rendered text — so a re-mount shows a higher number and a
// no-op leaves it unchanged. No prying at internals.
const onScreen = page => page.evaluate(() => window.visibleText());
const shownMount = async page => {
    const match = (await onScreen(page)).match(/#(\d+)/);
    return match ? Number(match[1]) : 0;
};

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });

    // The value from the deep module (b.js, via a.js) is on screen.
    await page.waitForFunction(() => window.visibleText().includes('HOUSE-LEFT'), { timeout: 20000 });
    const mountsAtStart = await shownMount(page);

    // Edit the two-hops-deep module. It must go live — and the canvas must
    // actually re-mount (fresh transitive fetch, not a stale cached b.js).
    fs.writeFileSync(path.join(workspace, 'home', 'b.js'), "export const LABEL = 'HOUSE-RIGHT';\n");
    await page.waitForFunction(
        () => window.visibleText().includes('HOUSE-RIGHT') && !window.visibleText().includes('HOUSE-LEFT'),
        { timeout: 20000 }
    ).catch(() => { throw new Error('editing a deep import (b.js) did not go live — transitive graph not tracked/re-fetched'); });

    const mountsAfterEdit = await shownMount(page);
    if (!(mountsAfterEdit > mountsAtStart)) {
        throw new Error(`b.js edit did not re-mount the canvas (shown mount ${mountsAtStart} -> ${mountsAfterEdit})`);
    }

    // Edit a file nobody imports. It must NOT re-mount the canvas: reloads follow
    // the import closure, not the folder. Give any erroneous reload time to land.
    fs.writeFileSync(path.join(workspace, 'home', 'unused.js'), "export const UNUSED = 'v2';\n");
    await sleep(3000);

    const mountsAfterUnused = await shownMount(page);
    if (mountsAfterUnused !== mountsAfterEdit) {
        throw new Error(`editing an un-imported file re-mounted the canvas (shown mount ${mountsAfterEdit} -> ${mountsAfterUnused}) — reload not scoped to the import graph`);
    }
    if (!(await onScreen(page)).includes('HOUSE-RIGHT')) {
        throw new Error('the moved value "HOUSE-RIGHT" is no longer on screen after the un-imported edit');
    }
};
