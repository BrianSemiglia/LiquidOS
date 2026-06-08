#!/usr/bin/env node
//
// probe-component-chrome-lifted.mjs
//
// The chrome row above each component (the container holding the
// Requirements button and, when surfaced, the Repair button) should
// sit ABOVE the component card without taking up layout space inside
// it. The whole container lifts together so multiple buttons stay
// aligned.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'requirements-modal-intrinsic.liquidos');
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-narrow]', { timeout: 15000 });
    // Hover to surface the chrome.
    await page.locator('.harness-component-frame-watcher').first().hover();
    await sleep(200);

    const layout = await page.evaluate(() => {
        const item   = document.querySelector('.harness-component-frame-watcher')?.closest('.item');
        const frame  = document.querySelector('.harness-component-frame-watcher');
        const chrome = frame?.querySelector('.component-chrome');
        const front  = frame?.querySelector('.component-front');
        const rect = (el) => el ? el.getBoundingClientRect() : null;
        return {
            item:   rect(item),
            chrome: rect(chrome),
            front:  rect(front)
        };
    });
    console.log('layout:', layout);

    if (!layout.chrome || !layout.front || !layout.item) {
        console.error('FAIL: chrome, front, or item not found');
        exitCode = 1;
    } else {
        // Chrome must sit ABOVE the front, not overlap it.
        if (layout.chrome.bottom > layout.front.top + 1) {
            console.error('FAIL: chrome overlaps the front card — chrome.bottom=' + layout.chrome.bottom + ', front.top=' + layout.front.top);
            exitCode = 1;
        }
        // Chrome must stay INSIDE the item's bounds — not lifted above
        // into a neighboring component's space.
        if (layout.chrome.top < layout.item.top - 1) {
            console.error('FAIL: chrome leaks above item — chrome.top=' + layout.chrome.top + ', item.top=' + layout.item.top);
            exitCode = 1;
        }
        // Chrome should be aligned to the right edge of the card.
        if (Math.abs(layout.chrome.right - layout.front.right) > 2) {
            console.error('FAIL: chrome not right-aligned with card — chrome.right=' + layout.chrome.right + ', front.right=' + layout.front.right);
            exitCode = 1;
        }
    }

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
