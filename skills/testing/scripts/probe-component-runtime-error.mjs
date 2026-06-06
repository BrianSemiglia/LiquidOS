#!/usr/bin/env node
//
// probe-component-runtime-error.mjs
//
// The fixture's runtime-error/functions.js mounts cleanly, then throws
// asynchronously via setTimeout. window.onerror in the harness attributes
// the error to the component by matching its stack against the known
// functions.js URL, then:
//   1. unhides [data-runtime-repair-callback] (the wrench button next to
//      the Requirements flip on the front face), with the error message
//      baked into its prompt attribute, and
//   2. POSTs to /diagnostics so the component's diagnostics/status.json
//      gets runtime.ok:false.
//
// Probe asserts on both.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'component-runtime-error.liquidos');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture, '--app', appRoot
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sandbox = await new Promise((resolve, reject) => {
    let buf = '';
    const onExit = () => reject(new Error('sandbox launcher exited before printing url'));
    launcher.on('exit', onExit);
    launcher.stdout.on('data', chunk => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
            launcher.off('exit', onExit);
            try { resolve(JSON.parse(buf.slice(0, nl))); }
            catch (e) { reject(new Error('non-json launcher output: ' + buf.slice(0, 200))); }
        }
    });
    launcher.stderr.on('data', c => process.stderr.write('[launcher] ' + c.toString('utf8')));
});

const cleanup = () => { try { launcher.kill('SIGTERM'); } catch {} };
process.on('SIGINT', () => { cleanup(); process.exit(130); });

let exitCode = 0;
try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-runtime-error]', { timeout: 20000 });

    // 1) Wrench callback appears next to the flip button.
    await page.waitForFunction(
        () => {
            const cb = document.querySelector('[data-runtime-repair-callback]');
            return cb && !cb.hidden;
        },
        { timeout: 8000 }
    );
    const promptOnCallback = await page.locator('[data-runtime-repair-callback]').getAttribute('prompt');
    console.log('runtime repair prompt:', (promptOnCallback || '').slice(0, 140) + '…');
    if (!promptOnCallback || !promptOnCallback.includes('SIMULATED_RUNTIME_ERROR_FOR_TEST')) {
        console.error('FAIL: runtime repair prompt does not embed the error message');
        exitCode = 1;
    }

    // 2) The button inside the callback is real and clickable.
    const buttonText = (await page.locator('[data-runtime-repair-callback] button').textContent() || '').trim();
    if (buttonText !== 'Repair') {
        console.error('FAIL: runtime repair button text is "' + buttonText + '", expected "Repair"');
        exitCode = 1;
    }

    // 2b) Hover the component frame and confirm the Repair button is
    // actually visible (i.e. the wrapper is hidden=false AND the chrome's
    // hover-reveal opacity transition completed). This catches the class
    // of regression where the wrapper exists in the DOM but is visually
    // hidden by CSS.
    await page.locator('.harness-component-frame-watcher').first().hover();
    await sleep(300);
    const repairVisible = await page.locator('[data-runtime-repair-callback] button').isVisible();
    if (!repairVisible) {
        console.error('FAIL: Repair button not visible after hovering the frame');
        exitCode = 1;
    }

    // 2c) Runtime error survives an incidental re-mount. render.js
    // services routinely regenerate view.json on restart (port
    // substitution), which flips htmlChanged true even though no code
    // was fixed. The Repair button must not vanish on that path —
    // re-mounts should leave runtime UI state alone, same shape as the
    // modal's __requirementsOverlay filter. Simulate by directly
    // rewriting view.json with a trivial difference; assert the button
    // stays visible throughout the next ~250ms.
    const viewJsonPath = path.join(sandbox.workspace, 'home', 'components', 'runtime-error', 'presented', 'view.json');
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
            console.error(`FAIL: Repair button disappeared at t=${(t * 25 + 25)}ms after view.json regeneration (re-mount cleared __runtimeError)`);
            exitCode = 1;
            break;
        }
    }
    if (!flickerDetected) {
        console.log('repair button persisted across re-mount: ok');
    }

    // 3) Diagnostics/status.json gets runtime.ok:false. The POST is
    // best-effort and asynchronous so allow a short window to land.
    const statusPath = path.join(sandbox.workspace, 'home', 'components', 'runtime-error', 'diagnostics', 'status.json');
    let runtimeWritten = false;
    for (let i = 0; i < 20 && !runtimeWritten; i++) {
        try {
            const data = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            if (data && data.runtime && data.runtime.ok === false
                && typeof data.runtime.error === 'string'
                && data.runtime.error.includes('SIMULATED_RUNTIME_ERROR_FOR_TEST')) {
                runtimeWritten = true;
                console.log('diagnostics runtime entry:', JSON.stringify(data.runtime));
            }
        } catch {}
        if (!runtimeWritten) await sleep(150);
    }
    if (!runtimeWritten) {
        console.error('FAIL: diagnostics/status.json did not get runtime.ok:false with the error message');
        exitCode = 1;
    }

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
