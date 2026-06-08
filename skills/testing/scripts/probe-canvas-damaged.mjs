#!/usr/bin/env node
//
// probe-canvas-damaged.mjs
//
// A malformed input.json on the active canvas surfaces a red "canvas-
// repair" card in the DOM with a Repair button. The probe writes a bad
// input.json into the sandbox after boot (so the harness sees the
// change), then asserts on the rendered card.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-build.liquidos');
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
    await sleep(1500);

    // Pre-condition: no visible Repair button yet (an undamaged canvas
    // with no failing components shouldn't show one).
    const visibleRepairs = () => page.evaluate(() => {
        return Array.from(document.querySelectorAll('button'))
            .filter(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0)
            .length;
    });
    if (await visibleRepairs() !== 0) {
        console.error('FAIL: a Repair button was already visible before damage');
        exitCode = 1;
    }

    // Corrupt input.json mid-session — the watcher sees the change.
    const inputPath = path.join(sandbox.workspace, 'home', 'input.json');
    fs.writeFileSync(inputPath, '{ this is not valid JSON', 'utf8');

    // A Repair button surfaces — the user sees a broken canvas and can act on it.
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button'))
            .some(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0),
        { timeout: 8000 }
    );

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
