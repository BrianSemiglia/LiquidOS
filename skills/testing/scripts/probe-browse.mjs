#!/usr/bin/env node
//
// probe-browse.mjs
//
// Open the Browse overlay via the New button, type a query, observe a
// result card with the bundle's name from .share/feed.json. The local
// feed is the only search source we can drive deterministically without
// a second peer; that covers the search-and-render path. The remote-
// install path (peerId !== null in /network/install) returns 501 today,
// so it's out of scope here.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'browse.liquidos');
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
    await page.waitForSelector('#new-canvas', { timeout: 20000 });
    await sleep(1500);

    // Open Browse via the New button.
    await page.locator('#new-canvas').dispatchEvent('click');
    await page.waitForSelector('#browse-overlay:not([hidden])', { timeout: 5000 });

    // Type a query that matches the bundle.
    await page.locator('#browse-query').fill('probe');
    // Wait for the local-feed result with the expected name to surface.
    await page.waitForFunction(
        () => {
            const cards = document.querySelectorAll('#browse-results .browse-result');
            return Array.from(cards).some(c => (c.querySelector('.browse-result-name')?.textContent || '').trim() === 'probe-bundle');
        },
        { timeout: 5000 }
    );

    const names = await page.locator('#browse-results .browse-result .browse-result-name').allTextContents();
    console.log('result names:', names);
    const subtitle = await page.locator('#browse-results .browse-result .browse-result-subtitle').first().textContent();
    console.log('subtitle    :', subtitle);
    if (!names.some(n => n.trim() === 'probe-bundle')) {
        console.error('FAIL: probe-bundle did not appear in browse results');
        exitCode = 1;
    }

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
