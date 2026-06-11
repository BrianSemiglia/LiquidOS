#!/usr/bin/env node
//
// probe-persist-no-chrome-leak.mjs
//
// User-visible bug: after triggering an lqpatch DOM op inside a
// <liquidos-component>, the component disappears (or progressively buries
// itself) because persistHostComponent serializes the LIVE DOM — which
// includes the runtime chrome that liquidos-component's buildShell()
// constructs (section.item > div.harness-component-frame-watcher >
// .component-chrome / .component-front > .surface, all as direct children
// of the component). On the next render, buildShell runs again and wraps
// the file-baked chrome inside *new* chrome. Each lqpatch adds a layer.
//
// This probe forces the bug to surface by:
//   1. Booting the agent-edit-stub fixture and triggering ONE dispatch,
//      which causes the stub agent to emit op="replace" against
//      #target-status (a DOM op inside the target <liquidos-component>).
//   2. After the dispatch lands, reading target/component.html on disk.
//   3. Asserting that the file does NOT contain runtime-chrome strings
//      (`harness-component-frame-watcher`, `class="surface"`,
//      `class="component-face`, `data-runtime-repair-callback`) — those
//      are produced by buildShell at render time, not authored source.
//   4. Asserting the component's authored content is still visible in the
//      page (#target-status exists and contains the persisted mark).
//
// If the chrome leaks into the persisted file, even one dispatch is
// enough to make the file diverge from the authored shape; reloading
// would then re-wrap and bury content further.
//

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'agent-edit-stub.liquidos');

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture,
    '--app', appRoot,
    '--agent', 'lqpatch-stream-stub'
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

let exitCode = 0;
try {
    const targetHtmlPath = path.join(sandbox.workspace, 'home/components/target/component.html');
    const beforeFile = fs.readFileSync(targetHtmlPath, 'utf8');
    expect('baseline component.html is the authored shape',
        !beforeFile.includes('harness-component-frame-watcher')
        && !beforeFile.includes('class="surface"'),
        'fixture is already chrome-poisoned: ' + beforeFile.slice(0, 200));

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!window.__lqpatch, undefined, { timeout: 10000 });
    await page.waitForSelector('#target-status', { timeout: 10000 });

    // Dispatch — agent emits op="replace" on #target-status (among others).
    const token = 'CHROME_' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const dispatch = await fetch(sandbox.url + '/output', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            scope: 'components/target/component.html',
            prompt: 'REPLACE_WITH: ' + token
        })
    });
    expect('dispatch returned 204', dispatch.status === 204,
        'got HTTP ' + dispatch.status);

    // Wait for the persist to land on disk.
    const persistMark = 'PERSISTED_' + token;
    const deadline = Date.now() + 15000;
    let afterFile = '';
    while (Date.now() < deadline) {
        afterFile = fs.readFileSync(targetHtmlPath, 'utf8');
        if (afterFile.includes(persistMark)) break;
        await sleep(120);
    }
    expect('persist landed: file contains the PERSIST mark',
        afterFile.includes(persistMark),
        'file: ' + afterFile.slice(0, 300));

    // --- the real assertion: runtime chrome must NOT leak into the file ---
    expect('persisted file has NO harness-component-frame-watcher',
        !afterFile.includes('harness-component-frame-watcher'),
        'chrome leaked: ' + afterFile.slice(0, 400));
    expect('persisted file has NO class="surface" wrapper',
        !afterFile.includes('class="surface"'),
        'chrome leaked: ' + afterFile.slice(0, 400));
    expect('persisted file has NO component-face wrapper',
        !afterFile.includes('component-face'),
        'chrome leaked: ' + afterFile.slice(0, 400));
    expect('persisted file has NO runtime-repair-callback wrapper',
        !afterFile.includes('data-runtime-repair-callback'),
        'chrome leaked: ' + afterFile.slice(0, 400));
    expect('persisted file is still a single liquidos-component root',
        (afterFile.match(/<liquidos-component\b/g) || []).length === 1,
        'multiple <liquidos-component> in file — likely nested wrappers: ' + afterFile.slice(0, 400));

    // --- and the user-visible side: component content still rendered ---
    const liveStatus = await page.evaluate(() =>
        document.getElementById('target-status')?.textContent || '');
    expect('live #target-status still rendered after persist',
        liveStatus.includes(persistMark),
        'live text: ' + JSON.stringify(liveStatus));

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error(e.message);
    exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
