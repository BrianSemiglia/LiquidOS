#!/usr/bin/env node
//
// probe-canvas-generate-gates.mjs
//
// The Generate button on the canvas requirements modal should only
// surface when ALL three are true:
//   1. The feature-requirements.txt file exists.
//   2. It is empty.
//   3. The canvas has at least one component.
//
// This probe exercises the third gate: the fixture has no components
// and an empty feature-requirements.txt. The Generate button must
// stay hidden.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-empty-no-components.liquidos');
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

    await page.locator('#canvas-info').click();
    await page.waitForSelector('#canvas-requirements-overlay:not([hidden])', { timeout: 5000 });
    // Give openCanvasRequirements time to fetch + decide.
    await sleep(500);

    const visible = await page.evaluate(() => {
        const cb = document.getElementById('canvas-requirements-recover-callback');
        return !!cb && !cb.hidden;
    });
    if (visible) {
        console.error('FAIL: Generate/Repair callback visible despite canvas having zero components');
        exitCode = 1;
    } else {
        console.log('PASS');
    }
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
