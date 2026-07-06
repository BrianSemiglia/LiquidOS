//
// probe-component-module-reload
//
// The component analog of probe-canvas-module-graph-reload: a script-mode
// <liquidos-file> component paints a value from a sibling module it imports
// (greeter/functions.js -> greeting.js). Editing that dependency must re-run the
// component and show the new value; editing a sibling nobody imports must not —
// the component reacts to its own import closure, not to every file in its
// folder.
//
// Asserted through the rendered screen only (the value and an on-screen mount
// number), never internals.
//
// Run it:  node run-probe.mjs probe-component-module-reload
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './workspace.liquidos';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const onScreen = page => page.evaluate(() => window.visibleText());
const shownMount = async page => {
    const match = (await onScreen(page)).match(/#(\d+)/);
    return match ? Number(match[1]) : 0;
};

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    const greeter = path.join(workspace, 'home', 'components', 'greeter');

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });

    // The value from the imported module is painted by the component's script.
    await page.waitForFunction(() => window.visibleText().includes('GREET-A'), { timeout: 20000 });
    const mountsAtStart = await shownMount(page);

    // Edit the imported dependency. The component must re-run and show it.
    fs.writeFileSync(path.join(greeter, 'greeting.js'), "export const GREETING = 'GREET-B';\n");
    await page.waitForFunction(
        () => window.visibleText().includes('GREET-B') && !window.visibleText().includes('GREET-A'),
        { timeout: 20000 }
    ).catch(() => { throw new Error("editing a component script's imported module (greeting.js) did not re-run the component"); });

    const mountsAfterEdit = await shownMount(page);
    if (!(mountsAfterEdit > mountsAtStart)) {
        throw new Error(`greeting.js edit did not re-run the component (shown mount ${mountsAtStart} -> ${mountsAfterEdit})`);
    }

    // Edit a sibling nobody imports. The component must NOT re-run.
    fs.writeFileSync(path.join(greeter, 'unused.js'), "export const UNUSED = 'v2';\n");
    await sleep(3000);

    const mountsAfterUnused = await shownMount(page);
    if (mountsAfterUnused !== mountsAfterEdit) {
        throw new Error(`editing an un-imported sibling re-ran the component (shown mount ${mountsAfterEdit} -> ${mountsAfterUnused}) — not scoped to the import closure`);
    }
    if (!(await onScreen(page)).includes('GREET-B')) {
        throw new Error('the updated value "GREET-B" is no longer on screen after the un-imported edit');
    }
};
