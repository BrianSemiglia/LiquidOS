#!/usr/bin/env node
//
// probe-active-canvas-file.mjs
//
// Verifies that writing active-canvas.json directly is equivalent to
// using the dropdown / POST /canvas — i.e., the file is the source of
// truth. The harness should observe the file change, swap the active
// canvas runtime, and the client should reflect the new selection.
//
// Steps:
//   1. Boot sandbox of canvas-switcher fixture (home + other canvases).
//   2. Confirm dropdown starts on `home`.
//   3. Write { "canvas": "other" } to <sandbox-workspace>/active-canvas.json.
//   4. Wait for the dropdown to flip to `other`.
//   5. Open the canvas-info modal and assert OTHER_CANVAS_MARKER is
//      present (the canvas content actually swapped, not just the label).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-switcher.liquidos');
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
    await page.waitForSelector('#canvas-select', { timeout: 20000 });
    await sleep(1500);

    // 1. Confirm we start on home.
    const initial = await page.locator('#canvas-select').inputValue();
    console.log('initial dropdown value:', initial);
    if (initial !== 'home') {
        console.error('FAIL: expected initial canvas to be `home`, got `' + initial + '`');
        exitCode = 1;
        throw new Error('initial state mismatch');
    }

    // 2. Write active-canvas.json directly — bypass the dropdown.
    const activeCanvasFile = path.join(sandbox.workspace, 'active-canvas.json');
    fs.writeFileSync(activeCanvasFile, JSON.stringify({ canvas: 'other' }, null, 2) + '\n');
    console.log('wrote active-canvas.json -> other');

    // 3. Client should pick up the change via SSE (canvases-changed) and
    //    reflect it in the dropdown.
    await page.waitForFunction(
        () => document.getElementById('canvas-select').value === 'other',
        { timeout: 5000 }
    );
    console.log('dropdown flipped to other');

    // 4. Verify the canvas content actually swapped — the canvas-info
    //    modal should show OTHER's feature-requirements.
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const ta = document.getElementById('canvas-requirements-textarea');
            return ta && ta.value && ta.value.includes('OTHER_CANVAS_MARKER');
        },
        { timeout: 5000 }
    );
    const otherText = (await page.locator('#canvas-requirements-textarea').inputValue()).trim();
    console.log('canvas-info modal:', otherText);
    if (otherText.includes('HOME_CANVAS_MARKER')) {
        console.error('FAIL: canvas-info showed home content after file-write switch');
        exitCode = 1;
    }

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
