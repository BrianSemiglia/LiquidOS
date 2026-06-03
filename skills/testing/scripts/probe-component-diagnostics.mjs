#!/usr/bin/env node
//
// probe-component-diagnostics.mjs
//
// The fixture's broken/functions.js is intentionally a syntax error.
// When the harness mounts that component, the dynamic import rejects
// and the catch path writes a visible "Component functions error:"
// message into the .status div on the item. Probe asserts the visible
// status element + class.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'component-diagnostics.liquidos');
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
    await page.waitForSelector('[data-broken]', { timeout: 20000 });
    await sleep(2000); // give the harness time to attempt the broken import

    // The harness writes the error to .status with class "status error"
    // and unhides it.
    await page.waitForFunction(
        () => {
            const s = document.querySelector('.item .status');
            return s && !s.hidden && /component functions error/i.test(s.textContent || '');
        },
        { timeout: 8000 }
    );
    const statusText = (await page.locator('.item .status').first().textContent() || '').trim();
    const statusClass = await page.locator('.item .status').first().getAttribute('class');
    console.log('status class:', statusClass);
    console.log('status text :', statusText);
    if (!/component functions error/i.test(statusText)) {
        console.error('FAIL: status did not contain mount-error message');
        exitCode = 1;
    }
    if (!statusClass.includes('error')) {
        console.error('FAIL: status missing "error" class');
        exitCode = 1;
    }

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
