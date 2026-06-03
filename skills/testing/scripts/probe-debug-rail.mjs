#!/usr/bin/env node
//
// probe-debug-rail.mjs
//
// Drag the #debug-resizer handle to a new x position; the harness's
// pointer handler updates the --debug-rail-width CSS variable. Probe
// asserts the variable's value changed, and that it persists in
// localStorage (the harness writes there for next-launch restore).

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

const readRailWidth = (page) => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--debug-rail-width').trim());

let exitCode = 0;
try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#debug-resizer', { timeout: 10000 });
    await sleep(800);

    const before = await readRailWidth(page);
    console.log('rail width before drag:', before);

    // Use real pointer events — the handler listens for pointerdown +
    // pointermove + pointerup with setPointerCapture.
    const handle = page.locator('#debug-resizer');
    const box = await handle.boundingBox();
    if (!box) throw new Error('could not measure #debug-resizer bounding box');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    // Drag to a substantially different position. Pick a value that the
    // harness's clamp (240 .. 55% viewport) will keep visible.
    const targetX = 600;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, startY, { steps: 5 });
    await page.mouse.up();
    await sleep(300);

    const after = await readRailWidth(page);
    console.log('rail width after drag :', after);
    if (after === before) {
        console.error('FAIL: --debug-rail-width did not change after drag');
        exitCode = 1;
    }

    // The harness persists width in localStorage.
    const persisted = await page.evaluate(() => localStorage.getItem('live-edit-debug-rail-width'));
    console.log('localStorage persisted:', persisted);
    if (!persisted || persisted.trim() === '') {
        console.error('FAIL: rail width was not persisted to localStorage');
        exitCode = 1;
    }

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
