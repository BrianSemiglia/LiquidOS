#!/usr/bin/env node
//
// probe-relationship-reactive-wiring.mjs
//
// A canvas with a working source->sink relationship AND a plain bystander
// component that exposes no __io. The relationship must wire as soon as its
// own peers (source, sink) are present — it must NOT wait on the bystander.
//
// Today wireIO waits for EVERY component to expose __io before connecting any
// relationship, so the bystander (which never will) drives it to its retry
// limit and it logs "wireIO: timed out … missing surface.__io". With reactive,
// peer-scoped wiring there is nothing to wait for and no such warning.
//
// Asserts only on rendered DOM + console: the sink shows the forwarded value,
// and no wireIO-timeout warning is logged.
//

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'relationship-reactive.liquidos');

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
    const wireWarnings = [];
    page.on('console', m => {
        if (m.type() === 'warning' && /wireio.*timed out/i.test(m.text())) wireWarnings.push(m.text());
    });
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // The relationship wires source -> sink; the sink paints the forwarded value.
    await page.waitForFunction(() =>
        document.querySelector('#sink-out')?.textContent === 'FROM_SOURCE',
        undefined, { timeout: 8000 });

    expect('relationship wired: sink shows the source value',
        (await page.evaluate(() => document.querySelector('#sink-out')?.textContent)) === 'FROM_SOURCE');

    // Give any (mistaken) timeout warning ample time to fire before asserting.
    await new Promise(r => setTimeout(r, 500));

    // The discriminator: the bystander (no __io, no relationship) must not have
    // held wiring hostage. Reactive wiring never waits on it; the old polling
    // does and logs a timeout.
    expect('no wireIO timeout warning (bystander did not block wiring)',
        wireWarnings.length === 0,
        'warnings: ' + JSON.stringify(wireWarnings));

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error(e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
