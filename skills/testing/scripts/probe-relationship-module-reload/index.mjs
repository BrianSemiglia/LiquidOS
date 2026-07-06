//
// probe-relationship-module-reload
//
// The relationship analog of the canvas/component module-reload probes. A
// relationship's functions.js forwards button presses to a sink with a label
// that lives in a sibling module it imports (source-to-sink/functions.js ->
// label.js). Editing that imported module must re-wire the relationship with
// the new label — proving relationships reload on a dependency edit, not only
// when their own functions.js changes.
//
// Verified through the UI: click the button, read the sink's text.
//
// Run it:  node run-probe.mjs probe-relationship-module-reload
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './workspace.liquidos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-source-btn]', { timeout: 20000 });
    await page.waitForSelector('[data-sink]', { timeout: 20000 });
    await sleep(2000); // let the relationship mount + connect()

    const sinkText = () => page.locator('[data-sink]').textContent().then(s => s.trim());
    const pressButton = () => page.locator('[data-source-btn]').dispatchEvent('click');

    // Initial wiring uses the label from the imported module.
    await pressButton();
    await sleep(300);
    if (await sinkText() !== 'v1') throw new Error('initial press did not propagate through the relationship');

    // Edit the module the relationship IMPORTS (not its own functions.js).
    fs.writeFileSync(path.join(workspace, 'home/relationships/source-to-sink/label.js'), "export const LABEL = 'v2';\n");
    await sleep(2500); // fs.watch -> graph refresh -> re-mount with fresh closure token

    // The next press must carry the new label — the relationship re-wired from
    // the edited dependency.
    await pressButton();
    await sleep(300);
    const after = await sinkText();
    if (after !== 'v2') {
        throw new Error(`editing a relationship's imported module did not re-wire it (sink shows "${after}", expected "v2")`);
    }
};
