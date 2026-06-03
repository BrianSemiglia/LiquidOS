#!/usr/bin/env node
//
// probe-canvas-create.mjs
//
// User clicks New → Browse overlay opens → user clicks the "from
// scratch" tile → name modal opens → user types a name + submits →
// canvas-select dropdown updates with the new canvas. UI-only; no
// agent involved.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-build.liquidos');
const NAME = 'probe-created-canvas';
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

    // Pre-condition: dropdown only has 'home'.
    const before = await page.locator('#canvas-select option').allTextContents();
    console.log('canvases before:', before);
    if (before.some(t => t.trim() === NAME)) {
        console.error('FAIL: canvas already existed before create');
        exitCode = 1;
    }

    // New → opens Browse overlay.
    await page.locator('#new-canvas').dispatchEvent('click');
    await page.waitForSelector('#browse-overlay:not([hidden])', { timeout: 5000 });
    // From-scratch tile → closes Browse, opens name modal.
    await page.locator('#browse-from-scratch').dispatchEvent('click');
    await page.waitForSelector('#new-canvas-backdrop:not([hidden])', { timeout: 5000 });
    // Type name + submit.
    await page.locator('#new-canvas-name').fill(NAME);
    await page.evaluate(() => document.getElementById('new-canvas-modal').requestSubmit());

    // Wait for the canvas-select dropdown to surface the new option.
    await page.waitForFunction(
        (target) => Array.from(document.querySelectorAll('#canvas-select option')).some(o => o.textContent.trim() === target),
        NAME,
        { timeout: 10000 }
    );
    const after = await page.locator('#canvas-select option').allTextContents();
    console.log('canvases after :', after);
    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
