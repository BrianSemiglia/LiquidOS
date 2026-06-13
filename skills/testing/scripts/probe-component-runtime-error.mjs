//
// probe-component-runtime-error.mjs
//
// The fixture's runtime-error/functions.js mounts cleanly, then throws
// asynchronously via setTimeout. The harness:
//   1. window.onerror attributes the throw to this component (matches
//      the stack against the known functions.js URL),
//   2. POSTs to /diagnostics with runtime.ok:false,
//   3. the server broadcasts so /input refreshes,
//   4. graph.js derives component.needsRepair = true,
//   5. the client renders the Repair button.
//
// State drives render. The button persists across incidental re-mounts
// because it's driven by the diagnostics file, not in-memory state. It
// clears when diagnostics is updated to ok:true (no special-case event
// handling, no timers).
//
// Run it:  node run-probe.mjs probe-component-runtime-error.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = 'component-runtime-error.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-runtime-error]', { timeout: 20000 });

    // 1) Repair callback appears once diagnostics shows runtime.ok:false.
    await page.waitForFunction(
        () => {
            const cb = document.querySelector('[data-runtime-repair-callback]');
            return cb && !cb.hidden;
        },
        { timeout: 8000 }
    );

    // 2) Button reads "Repair".
    const buttonText = (await page.locator('[data-runtime-repair-callback] button').textContent() || '').trim();
    if (buttonText !== 'Repair') {
        throw new Error('runtime repair button text is "' + buttonText + '", expected "Repair"');
    }

    // 2b) Visible after hovering the frame.
    await page.locator('.harness-component-frame-watcher').first().hover();
    await sleep(300);
    const repairVisible = await page.locator('[data-runtime-repair-callback] button').isVisible();
    if (!repairVisible) {
        throw new Error('Repair button not visible after hovering the frame');
    }

    // 2c) Repair persists across incidental re-mounts (state lives on disk,
    // not in JS memory). Touch view.json to flip htmlChanged → re-mount;
    // assert the button stays visible.
    const viewJsonPath = path.join(workspace, 'home', 'components', 'runtime-error', 'presented', 'view.json');
    const originalView = fs.readFileSync(viewJsonPath, 'utf8');
    const parsed = JSON.parse(originalView);
    parsed.html = String(parsed.html || '') + '<!-- regenerated -->';
    fs.writeFileSync(viewJsonPath, JSON.stringify(parsed, null, 2) + '\n');
    let flickerDetected = false;
    for (let t = 0; t < 10; t++) {
        await sleep(25);
        await page.locator('.harness-component-frame-watcher').first().hover();
        const stillVisible = await page.locator('[data-runtime-repair-callback] button').isVisible();
        if (!stillVisible) {
            flickerDetected = true;
            throw new Error(`Repair button disappeared at t=${(t * 25 + 25)}ms after view.json regeneration`);
        }
    }
    if (!flickerDetected) {
        console.log('repair button persisted across re-mount: ok');
    }

    // 3) After a fix — a re-mount that runs cleanly without throwing —
    // the Repair button disappears. The agent's "fix" here is a fresh
    // functions.js that no longer throws; the lib watches its own
    // mounts and clears runtime once the quiet window elapses with no
    // error. No harness-side file-edit heuristic involved.
    const functionsJsPath = path.join(workspace, 'home', 'components', 'runtime-error', 'presented', 'functions.js');
    fs.writeFileSync(functionsJsPath, 'export const mount = () => () => {};\n');
    await page.waitForFunction(
        () => {
            const cb = document.querySelector('[data-runtime-repair-callback]');
            return cb && cb.hidden === true;
        },
        { timeout: 5000 }
    ).catch(() => {
        throw new Error('Repair button did not disappear after the source was fixed');
    });
    console.log('repair button cleared after clean re-mount: ok');
};
