#!/usr/bin/env node
//
// probe-create-relationship-scaffolds.mjs
//
// Scaffold a canvas with two components (a source button + a sink
// span) and a relationship that wires them, then drive the UI:
// clicking the source button must update the sink. If
// create-relationship.sh produces a non-functional scaffold (wrong
// path, missing surface.__io, wrong peers shape), the click doesn't
// propagate and the probe times out.
//
// The probe customizes the scaffolded components and relationship
// after scaffolding — the scaffold lays down a structurally correct
// template; the probe fills in concrete behavior so the wire is
// driveable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const createComponent = path.join(appRoot, 'skills/component/scripts/create-component.sh');
const createRelationship = path.join(appRoot, 'skills/relationships/scripts/create-relationship.sh');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-create-relationship-'));
const ws = path.join(tmp, 'probe-create-relationship.liquidos');
fs.mkdirSync(ws, { recursive: true });
const canvasDir = path.join(ws, 'home');
fs.mkdirSync(canvasDir, { recursive: true });
fs.writeFileSync(path.join(canvasDir, 'input.json'), '{ "components": [] }\n');
fs.writeFileSync(path.join(canvasDir, 'canvas.js'), "import { cssLayout } from '/lib/css-layout.js';\nexport default cssLayout('');\n");

const run = (label, ...args) => {
    const r = spawnSync('bash', args, { encoding: 'utf8' });
    if (r.status !== 0) {
        console.error('FAIL:', label, 'exited', r.status, '\n', r.stderr);
        process.exit(1);
    }
};

run('create-component(source)', createComponent, canvasDir, 'source');
run('create-component(sink)',   createComponent, canvasDir, 'sink');
run('create-relationship',      createRelationship, canvasDir, 'source', 'sink');

const sourceDir = path.join(canvasDir, 'components', 'source');
const sinkDir   = path.join(canvasDir, 'components', 'sink');
const relDir    = path.join(canvasDir, 'relationships', 'source-to-sink');

// Replace the scaffolded view.json + functions.js with versions that
// expose driveable behavior — the scaffold's defaults are "Loading…"
// placeholders and a no-op mount. We're testing the wire, not the
// templates.
fs.writeFileSync(path.join(sourceDir, 'view.json'), JSON.stringify({
    html: '<button data-source-btn type="button">Press</button>'
}, null, 2) + '\n');
fs.writeFileSync(path.join(sourceDir, 'functions.js'),
`export const mount = (surface) => {
    const btn = surface.querySelector('[data-source-btn]');
    const listeners = new Set();
    const onClick = () => listeners.forEach(fn => { try { fn(); } catch {} });
    btn.addEventListener('click', onClick);
    surface.__io = {
        on(channel, fn) {
            if (channel !== 'press' || typeof fn !== 'function') return () => {};
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        send() {},
        connect() {}
    };
    return () => btn.removeEventListener('click', onClick);
};
`);

fs.writeFileSync(path.join(sinkDir, 'view.json'), JSON.stringify({
    html: '<span data-sink>nothing yet</span>'
}, null, 2) + '\n');
fs.writeFileSync(path.join(sinkDir, 'functions.js'),
`export const mount = (surface) => {
    const el = surface.querySelector('[data-sink]');
    surface.__io = {
        on() { return () => {}; },
        send(channel, payload) {
            if (channel === 'show') el.textContent = String(payload);
        },
        connect() {}
    };
};
`);

// Replace the scaffolded relationship's functions.js with one that
// wires press → show with a deterministic payload. We're testing the
// scaffolded SHAPE (does the canvas pick it up, does the harness
// mount it, does connect run with both peers?), not the placeholder
// channel names.
fs.writeFileSync(path.join(relDir, 'functions.js'),
`export const mount = (surface) => {
    let off = null;
    surface.__io = {
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const from = peers['source'];
            const to = peers['sink'];
            if (!from || !to) return;
            off = from.on('press', () => to.send('show', 'wired'));
        }
    };
    return () => { if (off) { try { off(); } catch {} ; off = null; } };
};
`);

// Strip out the scaffolded start.sh from each component's component.html
// — those services try to compile/run swiftc & node, which slows boot
// and isn't relevant to the wire test. The scaffolded component.html
// has <liquidos-file ... run> for start.sh; just drop it.
for (const dir of [sourceDir, sinkDir]) {
    const file = path.join(dir, 'component.html');
    const html = fs.readFileSync(file, 'utf8')
        .replace(/\s*<liquidos-file[^>]*start\.sh[^>]*><\/liquidos-file>\s*/, '\n    ');
    fs.writeFileSync(file, html);
}

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', ws, '--app', appRoot
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

const cleanup = () => {
    try { launcher.kill('SIGTERM'); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });

let exitCode = 0;
try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for both components.
    await page.waitForSelector('[data-source-btn]', { timeout: 20000 });
    await page.waitForSelector('[data-sink]',       { timeout: 20000 });
    // Let the relationship connect.
    await new Promise(r => setTimeout(r, 800));

    await page.locator('[data-source-btn]').click();
    await page.waitForFunction(
        () => document.querySelector('[data-sink]')?.textContent === 'wired',
        { timeout: 5000 }
    );

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
