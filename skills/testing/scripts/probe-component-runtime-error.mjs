//
// probe-component-runtime-error.mjs
//
// The fixture's runtime-error/functions.js mounts cleanly, then throws
// asynchronously via setTimeout. The harness attributes the throw to the
// component, records it in diagnostics, and surfaces a "Repair" affordance.
// State drives render: the affordance is there because diagnostics say so, so
// it survives an incidental re-mount and clears once the source is fixed —
// no special-case event handling, no timers.
//
// Asserts only what a person sees on screen (the word "Repair" coming and
// going), never the harness's internal elements or attributes.
//
// Run it:  node run-probe.mjs probe-component-runtime-error.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './probe-component-runtime-error.liquidos';

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const onScreen = (text) => page.waitForFunction(
        t => visibleText().includes(t), text, { timeout: 8000 });
    const offScreen = (text) => page.waitForFunction(
        t => !visibleText().includes(t), text, { timeout: 8000 });

    // The component renders its own content.
    await page.waitForFunction(
        t => visibleText().includes(t),
        'component that throws asynchronously after mount', { timeout: 20000 });

    // 1) The thrown error surfaces a "Repair" affordance the user can see.
    await onScreen('Repair').catch(() => {
        throw new Error('"Repair" never appeared on screen after the runtime error');
    });

    // 2) It survives an incidental re-mount — driven by the diagnostics file on
    // disk, not in-memory state. Touch component.html to force a re-mount;
    // "Repair" is still on screen once it settles.
    const compHtmlPath = path.join(workspace, 'home', 'components', 'runtime-error', 'component.html');
    const originalHtml = fs.readFileSync(compHtmlPath, 'utf8');
    fs.writeFileSync(compHtmlPath, originalHtml.replace('</liquidos-component>', '<!-- regenerated -->\n</liquidos-component>'));
    await onScreen('Repair').catch(() => {
        throw new Error('"Repair" did not survive a component.html re-mount');
    });
    console.log('repair affordance survived re-mount: ok');

    // 3) After the source is fixed (a fresh functions.js that no longer throws),
    // "Repair" clears from the screen. State drives render: the lib clears the
    // runtime error once its mounts run quiet, no harness-side file heuristic.
    const functionsJsPath = path.join(workspace, 'home', 'components', 'runtime-error', 'presented', 'functions.js');
    fs.writeFileSync(functionsJsPath, 'export const mount = () => () => {};\n');
    await offScreen('Repair').catch(() => {
        throw new Error('"Repair" did not clear from screen after the source was fixed');
    });
    console.log('repair affordance cleared after fix: ok');
};
