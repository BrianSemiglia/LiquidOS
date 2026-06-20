//
// probe-ui-state-component-requirements.mjs
//
// ui-state.json's componentRequirements key opens one component's requirements
// editor by its scope (folder path) — the agent's path to flipping a component
// for the user, equivalent to the user clicking the component's "Requirements"
// button. The flip button reads "Requirements" on the front and "Close" on the
// back, so that visible text tracks the editor opening and closing. Writing the
// component's own scope opens it; writing {} closes it.
//
// Run it:  node run-probe.mjs probe-ui-state-component-requirements.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = 'component-repair.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-probe]', { timeout: 20000 });
    await sleep(1500);

    const flip = page.locator('[data-component-flip]').first();
    const flipText = async () => (await flip.textContent() || '').trim();

    // Front to start: the button invites you to open the requirements.
    if (await flipText() !== 'Requirements') {
        throw new Error('front state should read "Requirements", got: ' + await flipText());
    }

    // The component's scope is its folder path — what ui-state.json keys on, the
    // same string the harness reports for the component. Read it off the flipped
    // component's own item (its nearest [data-component-path] ancestor).
    const scope = await page.evaluate(() =>
        document.querySelector('[data-component-flip]')?.closest('[data-component-path]')?.dataset.componentPath || '');
    if (!scope) throw new Error('could not read a component scope from the page');

    const uiStateFile = path.join(workspace, 'ui-state.json');
    const write = (state) => {
        fs.writeFileSync(uiStateFile, JSON.stringify(state, null, 2) + '\n');
        console.log('wrote ui-state.json ->', JSON.stringify(state));
    };

    // Agent writes the component's scope → its requirements editor opens, so the
    // flip button now reads "Close".
    write({ componentRequirements: scope });
    await page.waitForFunction(
        () => (document.querySelector('[data-component-flip]')?.textContent || '').trim() === 'Close',
        { timeout: 6000 }
    ).catch(() => { throw new Error('writing the component scope did not open its requirements editor (flip never read "Close")'); });

    // Agent clears it → the editor closes, the button reads "Requirements" again.
    write({});
    await page.waitForFunction(
        () => (document.querySelector('[data-component-flip]')?.textContent || '').trim() === 'Requirements',
        { timeout: 6000 }
    ).catch(() => { throw new Error('writing {} did not close the component requirements editor (flip never returned to "Requirements")'); });

    console.log('component requirements opened by scope and closed by {} ✓');
};
