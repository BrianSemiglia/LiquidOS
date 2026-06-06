#!/usr/bin/env node
//
// probe-canvas-teardown-rewrap.mjs
//
// When canvas.js is edited mid-session, the harness must re-instantiate
// the presentation: it calls currentCanvas.teardown() (which typically
// runs root.innerHTML = '') and then the new canvas's place(items, ...).
// The items handed to place() are the same DOM nodes the previous canvas
// had — they're still pinned to their old per-item wrappers, which are
// now sitting in a detached subtree. A canvas that uses the standard
// "if my wrapper is already this item's parent, reuse it" pattern will
// keep the detached wrappers and the items never reach the new world.
//
// This probe boots a fixture whose canvas wraps items in `.test-card`
// inside a `.test-world`, asserts the items are visible, edits canvas.js
// to force a teardown + re-place, and asserts the items are STILL inside
// the new world. Without the harness contract fix, the second assertion
// fails (items remain in detached old wrappers).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-teardown-rewrap.liquidos');
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
    const headed = process.env.HEADED === '1' || process.env.HEADED === 'true';
    const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 400 : 0 });
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.test-world', { timeout: 20000 });
    await page.waitForFunction(
        () => document.querySelectorAll('.test-world .test-card').length === 2,
        { timeout: 10000 }
    );

    const before = await page.evaluate(() => ({
        wrapsInWorld: document.querySelectorAll('.test-world > .test-card').length,
        itemsInWorld: document.querySelectorAll('.test-world .item').length,
        bodyHasAlpha: !!document.body.querySelector('[data-test-card-alpha]'),
        bodyHasBeta: !!document.body.querySelector('[data-test-card-beta]')
    }));
    console.log('before edit:', before);

    if (headed) {
        console.log('--- look: ALPHA + BETA cards inside .test-world. holding 3s ---');
        await sleep(3000);
    }

    // Edit canvas.js — appending a trivial comment bumps mtime, which
    // changes canvasJsVersion in /input. The client re-imports canvas.js,
    // tears down the old instance, instantiates the new one, and calls
    // its place() with the same items.
    const canvasJsPath = path.join(sandbox.workspace, 'home', 'canvas.js');
    fs.writeFileSync(canvasJsPath, fs.readFileSync(canvasJsPath, 'utf8') + '\n// probe bump ' + Date.now() + '\n');
    console.log('--- edited canvas.js ---');

    // Give the re-instantiation a moment to settle. Pause longer in headed
    // mode so the human watching can see the disappear happen.
    await sleep(headed ? 4000 : 1500);

    const after = await page.evaluate(() => ({
        wrapsInWorld: document.querySelectorAll('.test-world > .test-card').length,
        itemsInWorld: document.querySelectorAll('.test-world .item').length,
        bodyHasAlpha: !!document.body.querySelector('[data-test-card-alpha]'),
        bodyHasBeta: !!document.body.querySelector('[data-test-card-beta]'),
        worldExists: !!document.querySelector('.test-world')
    }));
    console.log('after edit:', after);

    if (!after.worldExists) {
        console.error('FAIL: .test-world missing after canvas.js edit (new canvas did not mount)');
        exitCode = 1;
    }
    if (after.wrapsInWorld !== 2) {
        console.error('FAIL: expected 2 .test-card wraps inside new .test-world, got ' + after.wrapsInWorld);
        exitCode = 1;
    }
    if (after.itemsInWorld !== 2) {
        console.error('FAIL: expected 2 .item nodes inside new .test-world, got ' + after.itemsInWorld);
        exitCode = 1;
    }

    if (!exitCode) console.log('PASS');
    if (headed) {
        console.log('--- holding window open 5s so you can inspect ---');
        await sleep(5000);
    }
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
