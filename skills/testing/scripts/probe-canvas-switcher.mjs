#!/usr/bin/env node
//
// probe-canvas-switcher.mjs
//
// Open canvas-info on the active canvas (home) → the modal shows home's
// requirements.txt. Close. Switch to the "other" canvas via the
// dropdown. Open canvas-info again → the modal shows other's
// requirements.txt (not stale home content). Verifies the
// per-canvas content isolation through the user-facing switcher flow.

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

    // 1. Open canvas-info on home; assert HOME marker.
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const ta = document.getElementById('canvas-requirements-textarea');
            return ta && ta.value && ta.value.includes('HOME_CANVAS_MARKER');
        },
        { timeout: 5000 }
    );
    const homeText = (await page.locator('#canvas-requirements-textarea').inputValue()).trim();
    console.log('home modal:', homeText);
    await page.locator('#canvas-requirements-cancel').dispatchEvent('click');
    await sleep(300);

    // 2. Switch to "other" via the dropdown.
    await page.locator('#canvas-select').selectOption('other');
    await page.waitForFunction(
        () => document.getElementById('canvas-select').value === 'other',
        { timeout: 5000 }
    );
    await sleep(500);

    // 3. Open canvas-info; assert OTHER marker, NOT HOME's content.
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const ta = document.getElementById('canvas-requirements-textarea');
            return ta && ta.value && ta.value.includes('OTHER_CANVAS_MARKER');
        },
        { timeout: 5000 }
    );
    const otherText = (await page.locator('#canvas-requirements-textarea').inputValue()).trim();
    console.log('other modal:', otherText);
    if (otherText.includes('HOME_CANVAS_MARKER')) {
        console.error('FAIL: other-canvas modal showed home content');
        exitCode = 1;
    }

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
