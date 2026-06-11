#!/usr/bin/env node
//
// probe-canvas-damaged-transient-write.mjs
//
// An agent's op="streamFile" lands on input.json as a sequence of
// writes: empty (truncate), then partial JSON growing chunk by chunk,
// finally the valid full JSON. The file watcher fires on each write
// and parses input.json. While the file is partial, JSON.parse
// throws — that's expected. What's NOT expected is for the canvas
// to surface a "Repair" card because of those transient failures
// when the final state is valid.
//
// This probe simulates that write sequence and asserts the canvas
// stays healthy. Failure mode (the bug): a transient mid-stream
// parse error latches canvas-damaged.

import fs from 'node:fs';
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

const visibleRepairs = (page) => page.evaluate(() => {
    return Array.from(document.querySelectorAll('button'))
        .filter(b => (b.textContent || '').trim() === 'Repair'
            && b.getBoundingClientRect().width > 0)
        .length;
});

let exitCode = 0;
try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    if (await visibleRepairs(page) !== 0) {
        throw new Error('a Repair button was already visible before the streamed write');
    }

    // Watch the page for any Repair button appearing at any point —
    // even transiently — so we catch flashes the user would notice.
    await page.evaluate(() => {
        window.__repairSeen = false;
        const check = () => {
            const seen = Array.from(document.querySelectorAll('button'))
                .some(b => (b.textContent || '').trim() === 'Repair'
                    && b.getBoundingClientRect().width > 0);
            if (seen) window.__repairSeen = true;
        };
        new MutationObserver(check).observe(document.body, {
            subtree: true, childList: true, attributes: true
        });
        check();
    });

    // Simulate streamFile on input.json: truncate, then grow chunk by
    // chunk to the final valid JSON. Wait between each step so the FS
    // watcher has a chance to fire on every intermediate state.
    const inputPath = path.join(sandbox.workspace, 'home', 'input.json');
    const sequence = [
        '',
        '{',
        '{"comp',
        '{"components":',
        '{"components":[]}'
    ];
    for (const chunk of sequence) {
        fs.writeFileSync(inputPath, chunk, 'utf8');
        await sleep(150);
    }

    // Give the watcher time to settle after the final write.
    await sleep(1000);

    const seenTransient = await page.evaluate(() => window.__repairSeen);
    const stillVisible = await visibleRepairs(page);

    if (stillVisible > 0) {
        throw new Error('a Repair button is visible after the streamed write completed with valid JSON');
    }
    if (seenTransient) {
        throw new Error('a Repair button flashed during the streamed write — final input.json is valid, the user should not have seen damage');
    }

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
