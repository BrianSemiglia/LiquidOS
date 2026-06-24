//
// probe-ui-state-file.mjs
//
// ui-state.json is the single source of truth for the surface mode. Writing it
// directly is the agent's path — equivalent to the user's own gesture — so the
// harness observes the file change and every client drives the matching panel.
// The mode is mutually exclusive: engaged | prompt (bar hidden) | canvasPicker |
// canvasRequirements. Asserts visible strings ("↑" Send, the picker's "Create"
// card, the requirements editor's "Build"), never flags or geometry.
//
// Steps:
//   1. Boot a sandbox; engaged — prompt bar ("↑") visible, no panels open.
//   2. { "mode": "prompt" }              → prompt bar hides.
//   3. { "mode": "canvasPicker" }        → Spaces grid opens ("Create" appears).
//   4. { "mode": "canvasRequirements" }  → picker closes, editor opens ("Build").
//   5. {}                                → engaged again; prompt bar visible.
//   6. User Escape, then reload          → bar stays hidden (the gesture persisted).
//
// (The prompt bar slides out in every disengaged mode, so "↑" is only asserted
// when engaged. Everything is asserted through visible text — never a hidden flag
// or the file on disk; the reload in step 6 proves persistence through the view.)
//
// Run it:  node run-probe.mjs probe-ui-state-file.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './probe-ui-state-file.liquidos';

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    const onScreen = (text, timeout = 6000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });
    const offScreen = (text, timeout = 6000) => page.waitForFunction(
        t => !document.body.innerText.includes(t), text, { timeout });

    const uiStateFile = path.join(workspace, 'ui-state.json');
    const write = (state) => {
        fs.writeFileSync(uiStateFile, JSON.stringify(state, null, 2) + '\n');
        console.log('wrote ui-state.json ->', JSON.stringify(state));
    };

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });

    // 1. Engaged: prompt bar up, nothing open (no file = engaged).
    await onScreen('↑').catch(() => { throw new Error('prompt bar ("↑" Send) not visible on load'); });
    await offScreen('Create').catch(() => { throw new Error('canvas picker should be closed on load ("Create" already visible)'); });

    // 2. mode: prompt — hide the prompt bar (escape mode), bypassing Escape.
    write({ mode: 'prompt' });
    await offScreen('↑').catch(() => { throw new Error('{ mode: "prompt" } did not hide the prompt bar ("↑" still visible)'); });

    // 3. mode: canvasPicker — the Spaces grid's "Create" card appears.
    write({ mode: 'canvasPicker' });
    await onScreen('Create').catch(() => { throw new Error('{ mode: "canvasPicker" } did not open the Spaces grid ("Create" never appeared)'); });

    // 4. mode: canvasRequirements — the picker closes (mode is exclusive), the
    //    editor's "Build" button appears.
    write({ mode: 'canvasRequirements' });
    await offScreen('Create').catch(() => { throw new Error('{ mode: "canvasRequirements" } did not close the picker ("Create" still visible)'); });
    await onScreen('Build').catch(() => { throw new Error('{ mode: "canvasRequirements" } did not open the requirements editor ("Build" never appeared)'); });

    // 5. Close everything with an empty object → engaged: the editor's "Build"
    //    goes away and the prompt bar comes back.
    write({});
    await offScreen('Build').catch(() => { throw new Error('{} did not close the requirements editor ("Build" still visible)'); });
    await onScreen('↑').catch(() => { throw new Error('{} should leave the prompt bar visible ("↑" missing)'); });

    // 6. The reverse direction, proven through the view (not by reading the file):
    //    a user gesture must survive a reload. Press Escape to hide the bar, reload,
    //    and the bar must come back hidden — only possible if the gesture persisted.
    await page.keyboard.press('Escape');
    await offScreen('↑').catch(() => { throw new Error('Escape did not hide the prompt bar'); });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });
    await offScreen('↑').catch(() => { throw new Error('the hidden prompt bar did not survive a reload — the Escape gesture was not persisted'); });

    // And clearing it the same way restores the bar across a reload too.
    write({});
    await onScreen('↑').catch(() => { throw new Error('{} did not bring the prompt bar back after reload'); });
};
