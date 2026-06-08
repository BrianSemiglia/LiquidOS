#!/usr/bin/env node
//
// probe-canvas-requirements-live-refresh.mjs
//
// User opens the canvas requirements modal on an empty canvas, clicks
// Generate. The agent writes feature-requirements.txt. The textarea
// must pick up the agent's write WITHOUT the user closing and
// reopening the modal — otherwise the user sees the loading state
// stop, the textarea sit empty, and has no idea the agent finished.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-build.liquidos');

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

    // Wait for the canvas info button, then open the requirements modal.
    await page.locator('#canvas-info').click();
    await page.waitForSelector('#canvas-requirements-overlay:not([hidden])', { timeout: 5000 });
    // The fixture's canvas has no feature-requirements.txt → Generate
    // surfaces. Wait for it then click.
    await page.waitForSelector('#canvas-requirements-recover-callback:not([hidden]) button', { timeout: 5000 });
    await page.locator('#canvas-requirements-recover-callback button').click();

    // The agent runs and writes the file. The textarea must populate
    // in place — no reopen.
    await page.waitForFunction(
        () => document.getElementById('canvas-requirements-textarea')?.value?.includes('REPAIRED_CANVAS_BY_TEST_AGENT'),
        { timeout: 10000 }
    );

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
