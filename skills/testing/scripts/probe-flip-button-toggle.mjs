#!/usr/bin/env node
//
// probe-flip-button-toggle.mjs
//
// Verifies the component flip-button text toggles between 'Requirements'
// (front, click to open the back) and 'Close' (back, click to return).
//

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

    const flip = page.locator('[data-component-flip]').first();
    const front = await flip.textContent();
    if ((front || '').trim() !== 'Requirements') {
        console.error('FAIL: front state should read "Requirements", got:', front);
        exitCode = 1;
    }
    await flip.dispatchEvent('click');
    await sleep(400);
    const back = await flip.textContent();
    if ((back || '').trim() !== 'Close') {
        console.error('FAIL: back state should read "Close", got:', back);
        exitCode = 1;
    }
    await flip.dispatchEvent('click');
    await sleep(400);
    const frontAgain = await flip.textContent();
    if ((frontAgain || '').trim() !== 'Requirements') {
        console.error('FAIL: after closing, button should read "Requirements" again, got:', frontAgain);
        exitCode = 1;
    }
    if (!exitCode) {
        console.log('front:', front, '→ back:', back, '→ front again:', frontAgain);
        console.log('PASS');
    }
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
