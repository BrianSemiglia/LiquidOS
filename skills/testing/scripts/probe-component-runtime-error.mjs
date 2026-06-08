#!/usr/bin/env node
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
        console.error('FAIL: runtime repair button text is "' + buttonText + '", expected "Repair"');
        exitCode = 1;
    }

    // 2b) Visible after hovering the frame.
    await page.locator('.harness-component-frame-watcher').first().hover();
    await sleep(300);
    const repairVisible = await page.locator('[data-runtime-repair-callback] button').isVisible();
    if (!repairVisible) {
        console.error('FAIL: Repair button not visible after hovering the frame');
        exitCode = 1;
    }

    // 2c) Repair persists across incidental re-mounts (state lives on disk,
    // not in JS memory). Touch view.json to flip htmlChanged → re-mount;
    // assert the button stays visible.
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
            console.error(`FAIL: Repair button disappeared at t=${(t * 25 + 25)}ms after view.json regeneration`);
            exitCode = 1;
            break;
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
    const functionsJsPath = path.join(sandbox.workspace, 'home', 'components', 'runtime-error', 'presented', 'functions.js');
    fs.writeFileSync(functionsJsPath, 'export const mount = () => () => {};\n');
    await page.waitForFunction(
        () => {
            const cb = document.querySelector('[data-runtime-repair-callback]');
            return cb && cb.hidden === true;
        },
        { timeout: 5000 }
    ).catch(() => {
        console.error('FAIL: Repair button did not disappear after the source was fixed');
        exitCode = 1;
    });
    if (!exitCode) console.log('repair button cleared after clean re-mount: ok');

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
