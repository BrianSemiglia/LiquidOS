#!/usr/bin/env node
//
// probe-sharing.mjs
//
// Drives the per-instance Shared toggles through the UI and asserts on
// the UI's reflection of the toggle state. No agent involved (sharing
// is a pure write/read pair via /canvas/share and /component/.../share).
// The toggle's aria-checked is the user-visible source of truth.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'component-repair.liquidos');
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
    await page.waitForSelector('[data-probe]', { timeout: 20000 });
    await sleep(1500);

    // --- Canvas Shared toggle ----------------------------------------------
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForSelector('#canvas-share-switch', { state: 'visible', timeout: 5000 });
    await page.waitForFunction(
        () => {
            const b = document.getElementById('canvas-share-switch');
            return b && b.getAttribute('aria-checked') === 'false' && !b.hasAttribute('disabled');
        },
        { timeout: 5000 }
    );
    await page.locator('#canvas-share-switch').dispatchEvent('click');
    await page.waitForFunction(
        () => document.getElementById('canvas-share-switch').getAttribute('aria-checked') === 'true',
        { timeout: 5000 }
    );
    console.log('canvas Shared toggled ON (aria-checked=true)');

    // Close the modal.
    await page.locator('#canvas-requirements-cancel').dispatchEvent('click');
    await sleep(300);

    // --- Component Shared toggle (inherits ON from canvas) -----------------
    await page.locator('[data-component-flip]').first().dispatchEvent('click');
    // Wait for the component share switch to surface; it should now be
    // enabled and aria-checked='true' (canvas is shared, no per-component opt-out).
    await page.waitForFunction(
        () => {
            const b = document.querySelector('[data-component-share-switch]');
            return b && !b.hasAttribute('disabled') && b.getAttribute('aria-checked') === 'true';
        },
        { timeout: 5000 }
    );
    console.log('component Shared inherits ON (aria-checked=true)');

    // Click to opt-out at the component level.
    await page.locator('[data-component-share-switch]').dispatchEvent('click');
    await page.waitForFunction(
        () => document.querySelector('[data-component-share-switch]').getAttribute('aria-checked') === 'false',
        { timeout: 5000 }
    );
    console.log('component Shared opted OUT (aria-checked=false)');

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
