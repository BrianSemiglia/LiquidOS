#!/usr/bin/env node
//
// probe-service-reload-keeps-component-visible.mjs
//
// User-visible bug, reported live: clicking through the canvas (which
// causes a workspace edit + a service file rewrite) makes a component
// disappear from view until the page is reloaded. The thing the user
// notices is "the component is gone" — not anything about chrome,
// internal element nesting, or DOM trees. So this probe asserts on
// exactly that: after the harness goes through a real service-restart
// cycle, is the content still visible on screen?
//
// Flow under test:
//   1. Render the target component — view.json's marker AND #target-status
//      are visible on screen (non-zero size, not display:none / hidden /
//      opacity:0).
//   2. Drive the service-rewrite stub agent, which emits an op="writeFile"
//      patch against the component's service.sh.
//   3. The harness's run-mode liquidos-file detects service.sh changed
//      and calls scheduleRestart() — killing the old service and spawning
//      the new one.
//   4. Assert the same user-visible content is STILL on screen.
//

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'agent-service-restart.liquidos');

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture,
    '--app', appRoot,
    '--agent', 'service-rewrite-stub'
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
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!window.__lqpatch, undefined, { timeout: 10000 });
    await page.waitForSelector('#target-status', { timeout: 10000 });

    // visibility() asks ONLY what a user could see: real area on screen,
    // not display:none, not visibility:hidden, not opacity:0.
    const visibility = () => page.evaluate(() => {
        const visible = el => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
            return true;
        };
        const status = document.getElementById('target-status');
        const marker = document.querySelector('[data-marker]');
        return {
            statusVisible: visible(status),
            statusText: status?.textContent || '',
            markerVisible: visible(marker),
            markerText: marker?.textContent || ''
        };
    });

    // Wait for the view.json content to hydrate before checking baseline.
    await page.waitForFunction(() =>
        document.querySelector('[data-marker]')?.textContent?.includes('MARKER_BEFORE'),
        undefined, { timeout: 10000 });

    const before = await visibility();
    expect('baseline: #target-status visible with INITIAL',
        before.statusVisible && before.statusText.includes('INITIAL'),
        'before: ' + JSON.stringify(before));
    expect('baseline: view.json marker visible with MARKER_BEFORE',
        before.markerVisible && before.markerText.includes('MARKER_BEFORE'),
        'before: ' + JSON.stringify(before));

    // Dispatch — stub agent rewrites service.sh via op="writeFile".
    const token = 'REWRITE_' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const dispatch = await fetch(sandbox.url + '/output', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            scope: 'components/target/component.html',
            prompt: 'REWRITE_TAG: ' + token
        })
    });
    expect('dispatch returned 204', dispatch.status === 204,
        'got HTTP ' + dispatch.status);

    // Wait for the script rewrite to land on disk so we know the
    // restart actually had something to react to.
    const servicePath = path.join(sandbox.workspace, 'home/components/target/service.js');
    const writeDeadline = Date.now() + 10000;
    while (Date.now() < writeDeadline) {
        const body = fs.readFileSync(servicePath, 'utf8');
        if (body.includes(token)) break;
        await sleep(120);
    }
    expect('service.js on disk carries the rewrite tag',
        fs.readFileSync(servicePath, 'utf8').includes(token),
        'rewrite never reached disk');

    // Give the harness's scheduleRestart its 250ms debounce + spawn time.
    await sleep(1200);

    const after = await visibility();
    expect('after service reload: #target-status STILL visible with INITIAL',
        after.statusVisible && after.statusText.includes('INITIAL'),
        'status disappeared — after: ' + JSON.stringify(after));
    expect('after service reload: view.json marker STILL visible with MARKER_BEFORE',
        after.markerVisible && after.markerText.includes('MARKER_BEFORE'),
        'marker disappeared — after: ' + JSON.stringify(after));

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error(e.message);
    exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
