#!/usr/bin/env node
//
// probe-relationship-live-reload.mjs
//
// Verifies that when a relationship's functions.js is rewritten in place,
// the harness re-mounts the new code and the next user interaction shows
// the new behavior — without a page reload.
//
// The fixture has:
//   - a source component (a button that emits 'press')
//   - a sink component (a span whose text gets set on 'show')
//   - a relationship that wires source → sink, forwarding the press as
//     a 'show' message with payload "v1"
//
// The probe:
//   1. Loads the page, clicks the button, expects the sink to show "v1".
//   2. Rewrites the relationship's functions.js to send "v2" instead.
//   3. Clicks the button again, expects the sink to show "v2".
//
// Usage:
//   node skills/testing/scripts/probe-relationship-live-reload.mjs
//

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'relationship-reload.liquidos');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- boot the sandbox --------------------------------------------------

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture,
    '--app', appRoot
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

console.log('sandbox url:      ', sandbox.url);
console.log('sandbox workspace:', sandbox.workspace);
console.log();

const cleanup = () => {
    try { launcher.kill('SIGTERM'); } catch {}
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let exitCode = 0;

try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[page error]', err.message));

    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-source-btn]', { timeout: 20000 });
    await page.waitForSelector('[data-sink]', { timeout: 20000 });
    // Let the relationship mount and connect() run.
    await sleep(2000);

    const sinkText = () => page.locator('[data-sink]').textContent().then(s => s.trim());
    // dispatchEvent fires the click event directly on the button, bypassing
    // any harness chrome (flip-button overlay, etc.) that can intercept a
    // coordinate-based mouse click on a small fixture element. The press
    // event flow being tested is identical either way.
    const pressButton = () => page.locator('[data-source-btn]').dispatchEvent('click');

    // --- Step 1: initial behavior -------------------------------------
    await pressButton();
    await sleep(300);
    const afterFirst = await sinkText();
    console.log('after first press:', afterFirst);
    if (afterFirst !== 'v1') {
        console.error('FAIL: expected sink to show "v1" after first press, got:', afterFirst);
        exitCode = 1;
        throw new Error('initial press did not propagate');
    }

    // --- Step 2: rewrite the relationship's functions.js --------------
    const fnPath = path.join(
        sandbox.workspace,
        'home/relationships/source-to-sink/functions.js'
    );
    const updated = `
// v2: forwards button presses to sink with the label "v2".
export const mount = (surface) => {
    let off = null;
    surface.__io = {
        peers: ['source', 'sink'],
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const src = peers['source'];
            const dst = peers['sink'];
            if (!src || !dst) return;
            off = src.on('press', () => dst.send('show', 'v2'));
        },
    };
    return () => { if (off) { try { off(); } catch {} ; off = null; } };
};
`;
    fs.writeFileSync(fnPath, updated);
    console.log('functions.js rewritten — waiting for harness to re-attach...');
    // Give the fs.watch → broadcast → /input refresh → re-mount cycle time.
    await sleep(2500);

    // --- Step 3: new behavior -----------------------------------------
    await pressButton();
    await sleep(300);
    const afterRewrite = await sinkText();
    console.log('after rewrite + press:', afterRewrite);
    if (afterRewrite !== 'v2') {
        console.error('FAIL: expected sink to show "v2" after rewrite, got:', afterRewrite);
        exitCode = 1;
        throw new Error('rewrite did not re-attach');
    }

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error(e.message);
    if (!exitCode) exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
