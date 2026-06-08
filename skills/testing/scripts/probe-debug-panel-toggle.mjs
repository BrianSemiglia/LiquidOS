#!/usr/bin/env node
//
// probe-debug-panel-toggle.mjs
//
// Debug panel is hidden by default. window.liquidos.toggleDebug()
// shows it; calling again hides it. The Mac app's View menu calls
// this same JS, so verifying the toggle in a sandbox is verifying
// what the menu drives.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-build.liquidos');

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

const railVisible = (page) => page.evaluate(() => {
    const rail = document.querySelector('.debug-rail');
    if (!rail) return false;
    const style = getComputedStyle(rail);
    return style.display !== 'none' && rail.getBoundingClientRect().width > 0;
});

let exitCode = 0;
try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Module script that defines toggleDebug runs after an async import.
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
    // Clear any persisted state from previous runs.
    await page.evaluate(() => { try { localStorage.removeItem('liquidos:debug-open'); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });

    // 1. Hidden by default.
    if (await railVisible(page)) {
        console.error('FAIL: debug rail visible on first load — should be hidden by default');
        exitCode = 1;
    }

    // 2. toggleDebug shows it.
    const r1 = await page.evaluate(() => window.liquidos?.toggleDebug?.());
    if (r1 !== true) {
        console.error('FAIL: toggleDebug() should return true when opening, returned', r1);
        exitCode = 1;
    }
    if (!await railVisible(page)) {
        console.error('FAIL: debug rail still hidden after toggleDebug()');
        exitCode = 1;
    }

    // 3. toggleDebug again hides it.
    const r2 = await page.evaluate(() => window.liquidos?.toggleDebug?.());
    if (r2 !== false) {
        console.error('FAIL: toggleDebug() should return false when closing, returned', r2);
        exitCode = 1;
    }
    if (await railVisible(page)) {
        console.error('FAIL: debug rail still visible after second toggleDebug()');
        exitCode = 1;
    }

    // 4. State persists across reload (open then reload, must stay open).
    await page.evaluate(() => window.liquidos?.toggleDebug?.());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
    if (!await railVisible(page)) {
        console.error('FAIL: debug rail did not stay open after reload — localStorage persistence broken');
        exitCode = 1;
    }

    // 5. A previously-stored width must not reserve a grid column when
    // the panel is closed. This is the "panel hidden but the canvas
    // still leaves a dark gutter on the left" bug.
    await page.evaluate(() => {
        try {
            // Pretend the user previously dragged the rail wider.
            localStorage.setItem('live-edit-debug-rail-width', '420');
        } catch {}
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
    // Make sure we're in the closed state for the check.
    await page.evaluate(() => window.liquidos.setDebugOpen(false));
    const closedRailWidth = await page.evaluate(() =>
        getComputedStyle(document.body).getPropertyValue('--debug-rail-width').trim());
    if (closedRailWidth !== '0px') {
        console.error('FAIL: --debug-rail-width is', closedRailWidth, 'when panel closed — body grid still reserves a column');
        exitCode = 1;
    }

    // Clean up.
    await page.evaluate(() => {
        try {
            localStorage.removeItem('liquidos:debug-open');
            localStorage.removeItem('live-edit-debug-rail-width');
        } catch {}
    });

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
