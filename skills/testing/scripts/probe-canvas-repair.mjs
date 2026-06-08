#!/usr/bin/env node
//
// probe-canvas-repair.mjs
//
// User opens the canvas requirements modal on an empty canvas, clicks
// Repair → agent dispatched → test agent writes feature-requirements.txt.
// User closes the modal and reopens it; openCanvasRequirements re-fetches
// via /workspace/.../feature-requirements.txt every open, so the
// textarea now contains the agent's content. Probe asserts on that.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-build.liquidos');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture, '--app', appRoot, '--agent', 'canvas-repair-test'
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

    // Open the canvas requirements modal. Textarea empty; Repair surfaces.
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForSelector('#canvas-requirements-textarea', { state: 'visible', timeout: 5000 });
    await page.waitForFunction(
        () => {
            const cb = document.getElementById('canvas-requirements-recover-callback');
            return cb && !cb.hidden;
        },
        { timeout: 5000 }
    );
    // Click Repair.
    await page.locator('#canvas-requirements-recover-callback button').dispatchEvent('click');
    await sleep(500);

    // Close and reopen; openCanvasRequirements always re-fetches.
    await page.locator('#canvas-requirements-cancel').dispatchEvent('click');
    await sleep(300);
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const ta = document.getElementById('canvas-requirements-textarea');
            return ta && ta.value && ta.value.includes('REPAIRED_CANVAS_BY_TEST_AGENT');
        },
        { timeout: 5000 }
    );

    const textareaValue = await page.locator('#canvas-requirements-textarea').inputValue();
    console.log('textarea after Repair:', textareaValue.trim());
    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
