//
// probe-create-relationship-scaffolds.mjs
//
// Scaffold a relationship with create-relationship.sh between two
// components, fill in the scaffold's channel placeholders, and drive the
// UI: clicking the source button must update the sink. This tests that the
// scaffold is structurally correct — it declares __io.peers and its
// connect() wires the two peers — so the harness picks it up and the wire
// works end to end. If the scaffold dropped peers or shaped connect wrong,
// the click doesn't propagate and the probe times out.
//
// The two components are written directly in the current (inline
// <liquidos-component>) shape; only the relationship comes from the
// scaffold under test.
//
// Run it:  node run-probe.mjs probe-create-relationship-scaffolds.mjs
//
// NOTE: this probe builds its own temporary workspace at runtime (there is
// no static fixture). It exports fixture = null so that run-probe.mjs is
// told to pass --workspace via the probe itself. The probe launches its own
// sandbox internally and uses the provided browser from the wrapper.
//

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootSandbox } from './sandbox.mjs';

export const fixture = null;

export default async ({ browser }) => {
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    const appRoot = path.resolve(scriptsDir, '../../..');
    const createRelationship = path.join(appRoot, 'skills/relationships/scripts/create-relationship.sh');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-create-relationship-'));
    const ws = path.join(tmp, 'probe-create-relationship.liquidos');
    const canvasDir = path.join(ws, 'home');
    const sourceDir = path.join(canvasDir, 'components', 'source');
    const sinkDir = path.join(canvasDir, 'components', 'sink');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(sinkDir, { recursive: true });

    fs.writeFileSync(path.join(canvasDir, 'index.json'), JSON.stringify({
        components: ['components/source/component.html', 'components/sink/component.html']
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(canvasDir, 'canvas.js'), "import { cssLayout } from '/lib/css-layout.js';\nexport default cssLayout('');\n");

    // Source: a button that emits 'wired' on the 'val' channel when clicked.
    fs.writeFileSync(path.join(sourceDir, 'component.html'),
`<liquidos-component path="components/source">
    <button data-source-btn type="button">Press</button>
    <liquidos-file path="components/source/functions.js" script></liquidos-file>
</liquidos-component>
`);
    fs.writeFileSync(path.join(sourceDir, 'functions.js'),
`export const mount = (surface) => {
    const btn = surface.querySelector('[data-source-btn]');
    const listeners = new Set();
    const onClick = () => listeners.forEach(fn => { try { fn('wired'); } catch {} });
    btn.addEventListener('click', onClick);
    surface.__io = {
        on(channel, fn) {
            if (channel !== 'val' || typeof fn !== 'function') return () => {};
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        send() {}, connect() {},
    };
    return () => btn.removeEventListener('click', onClick);
};
`);

    // Sink: a span that paints whatever it receives on the 'val' channel.
    fs.writeFileSync(path.join(sinkDir, 'component.html'),
`<liquidos-component path="components/sink">
    <span data-sink>nothing yet</span>
    <liquidos-file path="components/sink/functions.js" script></liquidos-file>
</liquidos-component>
`);
    fs.writeFileSync(path.join(sinkDir, 'functions.js'),
`export const mount = (surface) => {
    const el = surface.querySelector('[data-sink]');
    surface.__io = {
        on() { return () => {}; },
        send(channel, payload) { if (channel === 'val') el.textContent = String(payload); },
        connect() {},
    };
};
`);

    // The thing under test: scaffold the relationship.
    const r = spawnSync('bash', [createRelationship, canvasDir, 'source', 'sink'], { encoding: 'utf8' });
    if (r.status !== 0) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error('create-relationship exited ' + r.status + '\n' + r.stderr);
    }

    // Fill in the scaffold's channel placeholder. We keep the scaffold's
    // declared peers and its connect() passthrough untouched — that's what we're
    // testing — and only name the channel both sides speak.
    const relFn = path.join(canvasDir, 'relationships', 'source-to-sink', 'functions.js');
    fs.writeFileSync(relFn, fs.readFileSync(relFn, 'utf8').replace(/<channel>/g, 'val'));
    if (!/peers:\s*\[/.test(fs.readFileSync(relFn, 'utf8'))) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error('scaffold did not declare __io.peers');
    }

    // Boot the sandbox internally (dynamic workspace — no static fixture).
    const sandbox = await bootSandbox(ws, { agent: 'agent/none-agent.js' });

    try {
        const page = await browser.newPage();
        page.on('pageerror', err => console.log('[page error]', err.message));
        await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        await page.waitForSelector('[data-source-btn]', { timeout: 20000 });
        await page.waitForSelector('[data-sink]', { timeout: 20000 });

        await page.locator('[data-source-btn]').click();
        await page.waitForFunction(
            () => document.querySelector('[data-sink]')?.textContent === 'wired',
            { timeout: 5000 }
        );
    } finally {
        try { sandbox.teardown(); } catch {}
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
};
