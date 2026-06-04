#!/usr/bin/env node
//
// probe-canvas-build.mjs
//
// User edits feature-requirements.txt + clicks Build → /canvas/requirements
// writes the file and dispatches the agent → test agent adds the
// pre-staged probe-built component to input.json → harness re-renders
// with the new component → probe observes the [data-canvas-build-marker]
// element in the DOM.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-build.liquidos');
const MARKER = 'PROBE_CANVAS_BUILD';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture, '--app', appRoot, '--agent', 'canvas-build-test'
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
    await sleep(1500);

    // Pre-condition: no probe-built marker visible yet.
    if (await page.locator('[data-canvas-build-marker]').count() !== 0) {
        console.error('FAIL: marker existed before Build');
        exitCode = 1;
    }

    // Open the canvas requirements modal.
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForSelector('#canvas-requirements-textarea', { state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => !document.getElementById('canvas-requirements-textarea').disabled, { timeout: 5000 });
    await page.locator('#canvas-requirements-textarea').fill('- ' + MARKER + '\n');
    await page.locator('#canvas-requirements-save').dispatchEvent('click');

    // The harness's input watcher re-renders the canvas after the agent
    // writes input.json; wait for the new component's marker to appear.
    try {
        await page.waitForSelector('[data-canvas-build-marker]', { timeout: 10000 });
        const markerText = (await page.locator('[data-canvas-build-marker]').textContent() || '').trim();
        console.log('observed marker:', markerText);
        if (markerText !== 'BUILT') {
            console.error('FAIL: marker text was not "BUILT"');
            exitCode = 1;
        }
    } catch (e) {
        console.error('FAIL: probe-built component never surfaced in the DOM');
        exitCode = 1;
    }

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
