#!/usr/bin/env node
//
// probe-canvas-error-recovers.mjs
//
// Canvas boots damaged → user sees the Repair card. The probe then
// rewrites input.json to a valid state (the "agent's fix"). The
// harness's canvasError clears, the canvas should paint its
// components fresh, and the Repair card must leave the DOM. Without
// that, restarting the app is the only way the user sees the fix.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-damaged-repair.liquidos');

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

    // The fixture boots with a broken input.json → Repair card appears.
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button'))
            .some(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0),
        { timeout: 10000 }
    );

    // Simulate the agent's fix: rewrite input.json to point at the
    // pre-staged repaired component.
    const inputPath = path.join(sandbox.workspace, 'home', 'input.json');
    fs.writeFileSync(inputPath, JSON.stringify({
        components: ['components/canvas-repaired/component.html']
    }, null, 2) + '\n');

    // The repaired component's view marker must appear...
    await page.waitForSelector('[data-canvas-repair-marker]', { timeout: 10000 });
    // ...and the Repair card must be gone.
    await page.waitForFunction(
        () => !document.querySelector('[role="group"][data-repair-level="canvas"]'),
        { timeout: 5000 }
    );

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
