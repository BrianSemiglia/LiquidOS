#!/usr/bin/env node
//
// probe-region-contention.mjs
//
// Two co-owning services stream exclusive replace patches at the same
// #shared region. X opens its replace stream first and holds it; Y keeps
// firing replaces at the same region. Only one producer may own a region
// at a time, so X must keep it and Y_INTRUDER must NEVER reach the view.
//
// A MutationObserver records every value #shared ever holds, so a single
// clobbered frame is caught. Without contention handling Y's replaces
// clobber X mid-stream and Y_INTRUDER shows up; with a per-region lease it
// never does. Asserts only on rendered DOM.
//

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'region-contention.liquidos');

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture, '--app', appRoot, '--agent', 'none'
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
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

let exitCode = 0;
try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Record every value #shared takes, including transient frames.
    await page.waitForFunction(() => !!document.querySelector('#shared'), undefined, { timeout: 10000 });
    await page.evaluate(() => {
        window.__sharedHistory = [];
        const el = document.querySelector('#shared');
        const rec = () => window.__sharedHistory.push(el.textContent);
        rec();
        new MutationObserver(rec).observe(el, { childList: true, characterData: true, subtree: true });
    });

    // X wins the region and streams into it.
    await page.waitForFunction(() =>
        /X\d/.test(document.querySelector('#shared')?.textContent || ''),
        undefined, { timeout: 8000 });

    // Let Y run against the held region for a couple of seconds.
    await new Promise(r => setTimeout(r, 2500));

    const history = await page.evaluate(() => window.__sharedHistory || []);
    const sawX = history.some(v => /X\d/.test(v));
    const sawIntruder = history.some(v => v.includes('Y_INTRUDER'));

    expect("X owns the region and streams into it",
        sawX, 'no X frames recorded');

    // The discriminator: the loser never reaches the view, not even for one
    // frame.
    expect("Y never clobbered the region X holds (no Y_INTRUDER frame)",
        !sawIntruder,
        'frames containing intruder: ' + JSON.stringify(history.filter(v => v.includes('Y_INTRUDER')).slice(0, 5)));

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error(e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
