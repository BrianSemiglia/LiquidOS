#!/usr/bin/env node
//
// probe-prompt-bar-single-dispatch.mjs
//
// User types into the prompt bar and submits once. The agent must be
// invoked exactly once. The stub agent writes a "dispatched once"
// marker on the first call and a "dispatched twice" marker on any
// subsequent call. Probe asserts the once-marker appears AND the
// twice-marker never does — proof that one user submit produces one
// dispatch.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'prompt-bar-single-dispatch.liquidos');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture, '--app', appRoot, '--agent', 'prompt-bar-single-dispatch-test'
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
    await page.waitForSelector('[data-counter-initial]', { timeout: 20000 });

    // Type a prompt and submit once via the Send button.
    await page.locator('#global-text').fill('probe single-dispatch');
    await page.locator('#global-prompt button[type="submit"]').click();

    // First marker arrives — that's the healthy path.
    await page.waitForSelector('[data-dispatched-once]', { timeout: 10000 });

    // Then wait long enough that any second auto-dispatch would have
    // completed and overwritten the view with the twice-marker.
    await sleep(2000);
    const doubled = await page.locator('[data-dispatched-twice]').count();
    if (doubled > 0) {
        const text = await page.locator('[data-dispatched-twice]').textContent();
        console.error('FAIL:', text);
        exitCode = 1;
    }

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
