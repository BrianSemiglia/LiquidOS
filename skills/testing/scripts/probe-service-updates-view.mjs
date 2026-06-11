#!/usr/bin/env node
//
// probe-service-updates-view.mjs
//
// A run-mode <liquidos-file> spawns service.js, which writes successive
// view.json values on a timer. The probe watches the rendered DOM and
// asserts it observes multiple SERVICE_STEP_<n> markers — that the
// service's writes reach the live view on screen.
//

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'service-writes-view.liquidos');

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

    // Collect every distinct marker text the live DOM cycles through
    // while the service is writing. We sample for a few seconds; the
    // service writes ~4 times per second, so several steps should
    // appear.
    const observed = new Set();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
        const marker = await page.evaluate(() =>
            document.querySelector('[data-marker]')?.textContent || '');
        if (marker && marker.startsWith('SERVICE_STEP_')) observed.add(marker);
        await new Promise(r => setTimeout(r, 100));
    }

    expect('observed at least three distinct service writes in the rendered view',
        observed.size >= 3,
        'distinct markers seen: ' + JSON.stringify([...observed]));

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error(e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
