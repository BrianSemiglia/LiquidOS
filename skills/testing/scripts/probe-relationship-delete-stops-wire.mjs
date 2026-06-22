//
// probe-relationship-delete-stops-wire.mjs
//
// The delete half of relationship authoring. A user removes a wire by
// deleting its line from the canvas's feature-requirements.txt; the agent
// reconciles by removing the matching relationships/<name>/ folder
// (delete-relationship.sh). The server discovers relationships by scanning
// that folder, so removing it must tear the live wire down — while leaving
// both endpoints working on their own.
//
// Creation is covered by probe-create-relationship-scaffolds. This probe is
// the inverse: start with a working source -> sink wire, delete it the way
// the agent would, and assert the behavior STOPS on screen without a reload.
//
//   1. Click the source button twice -> sink tracks the click count (wire live).
//   2. Delete the wire line from canvas requirements AND the relationship
//      folder (the reconciled end-state the agent produces).
//   3. Click the source again -> the source's OWN label keeps counting
//      (endpoint still alive) but the sink no longer follows (wire gone).
//
// The source emits an incrementing count so "no new value reaches the sink"
// is observable rather than ambiguous (a constant payload would look the same
// wired or not). The sink assertion is anchored to a baseline captured after
// the delete settles, so it holds whether or not the refresh re-mounts the
// endpoints.
//
// This probe builds its own temporary workspace (fixture = null) and boots
// its own sandbox, like probe-create-relationship-scaffolds.
//
// Run it:  node run-probe.mjs probe-relationship-delete-stops-wire.mjs
//

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootSandbox } from './sandbox.mjs';

export const fixture = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ browser }) => {
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    const appRoot = path.resolve(scriptsDir, '../../..');
    const deleteRelationship = path.join(appRoot, 'skills/relationships/scripts/delete-relationship.sh');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-relationship-delete-'));
    const ws = path.join(tmp, 'probe-relationship-delete.liquidos');
    const canvasDir = path.join(ws, 'home');
    const sourceDir = path.join(canvasDir, 'components', 'source');
    const sinkDir = path.join(canvasDir, 'components', 'sink');
    const relDir = path.join(canvasDir, 'relationships', 'source-to-sink');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(sinkDir, { recursive: true });
    fs.mkdirSync(relDir, { recursive: true });

    fs.writeFileSync(path.join(canvasDir, 'index.json'), JSON.stringify({
        components: ['components/source/component.html', 'components/sink/component.html']
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(canvasDir, 'canvas.js'), "import { cssLayout } from '/lib/css-layout.js';\nexport default cssLayout('');\n");

    // The wire described in prose — the source of truth the user edits. We
    // remove this line (alongside the folder) when we delete the wire.
    const wireLine = '- Clicking the source button updates the sink with the running click count.';
    const canvasReqs = path.join(canvasDir, 'feature-requirements.txt');
    fs.writeFileSync(canvasReqs, `## Relationships\n\n${wireLine}\n`);

    // Source: a button that, on click, increments a local count, shows it on
    // its own label (proves the endpoint is alive independent of the wire),
    // and notifies subscribers with the count on the 'val' channel.
    fs.writeFileSync(path.join(sourceDir, 'component.html'),
`<liquidos-component path="components/source">
    <button data-source-btn type="button">Press</button>
    <span data-source-count>clicks: 0</span>
    <liquidos-file path="components/source/functions.js" script></liquidos-file>
</liquidos-component>
`);
    fs.writeFileSync(path.join(sourceDir, 'functions.js'),
`export const mount = (surface) => {
    const btn = surface.querySelector('[data-source-btn]');
    const label = surface.querySelector('[data-source-count]');
    const listeners = new Set();
    let count = 0;
    const onClick = () => {
        count += 1;
        label.textContent = 'clicks: ' + count;
        listeners.forEach(fn => { try { fn(count); } catch {} });
    };
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

    // Sink: a span that paints whatever count it receives on the 'val' channel.
    fs.writeFileSync(path.join(sinkDir, 'component.html'),
`<liquidos-component path="components/sink">
    <span data-sink>received: none</span>
    <liquidos-file path="components/sink/functions.js" script></liquidos-file>
</liquidos-component>
`);
    fs.writeFileSync(path.join(sinkDir, 'functions.js'),
`export const mount = (surface) => {
    const el = surface.querySelector('[data-sink]');
    surface.__io = {
        on() { return () => {}; },
        send(channel, payload) { if (channel === 'val') el.textContent = 'received: ' + payload; },
        connect() {},
    };
};
`);

    // The wire under test: forward the source's count to the sink.
    fs.writeFileSync(path.join(relDir, 'functions.js'),
`export const mount = (surface) => {
    let off = null;
    surface.__io = {
        peers: ['source', 'sink'],
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const from = peers['source'];
            const to = peers['sink'];
            if (!from || !to) return;
            off = from.on('val', payload => to.send('val', payload));
        },
    };
    return () => { if (off) { try { off(); } catch {} ; off = null; } };
};
`);
    fs.writeFileSync(path.join(relDir, 'feature-requirements.txt'), wireLine.replace(/^- /, '') + '\n');

    // bootSandbox serves a COPY of the workspace at sandbox.workspace — the
    // running server never reads the dir we built above. Mutations after boot
    // (the delete, the requirements edit) must target the copy, or the server
    // never sees them.
    const sandbox = await bootSandbox(ws, { agent: 'agent/none-agent.js' });
    const liveCanvasDir = path.join(sandbox.workspace, 'home');
    const liveCanvasReqs = path.join(liveCanvasDir, 'feature-requirements.txt');
    const liveRelDir = path.join(liveCanvasDir, 'relationships', 'source-to-sink');

    try {
        const page = await browser.newPage();
        page.on('pageerror', err => console.log('[page error]', err.message));
        await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        await page.waitForSelector('[data-source-btn]', { timeout: 20000 });
        await page.waitForSelector('[data-sink]', { timeout: 20000 });
        // Let the relationship mount and connect() run.
        await sleep(2000);

        const sinkText = () => page.locator('[data-sink]').textContent().then(s => s.trim());
        const sourceText = () => page.locator('[data-source-count]').textContent().then(s => s.trim());
        // dispatchEvent fires the click directly on the button, bypassing any
        // harness chrome that could intercept a coordinate-based click on a
        // small fixture element — same event flow either way.
        const press = () => page.locator('[data-source-btn]').dispatchEvent('click');

        // --- Step 1: the wire is live ------------------------------------
        await press();
        await page.waitForFunction(
            () => document.querySelector('[data-sink]')?.textContent.trim() === 'received: 1',
            { timeout: 5000 }
        );
        await press();
        await page.waitForFunction(
            () => document.querySelector('[data-sink]')?.textContent.trim() === 'received: 2',
            { timeout: 5000 }
        );

        // --- Step 2: remove the wire the way the agent does ---------------
        // The user removes the prose line; the agent reconciles by deleting
        // the folder. Do both so the canvas matches the reconciled end-state.
        fs.writeFileSync(liveCanvasReqs, '## Relationships\n');
        const r = spawnSync('bash', [deleteRelationship, liveCanvasDir, 'source', 'sink'], { encoding: 'utf8' });
        if (r.status !== 0) {
            throw new Error('delete-relationship exited ' + r.status + '\n' + r.stderr);
        }
        if (fs.existsSync(liveRelDir)) {
            throw new Error('delete-relationship did not remove the folder');
        }
        // Give the fs.watch -> broadcast -> refresh -> re-scan cycle time to
        // tear the wire down (same budget as probe-relationship-live-reload).
        await sleep(2500);

        // Baseline after the delete settles. Anchoring the sink assertion here
        // makes it hold whether or not the refresh re-mounted the endpoints.
        const sinkBaseline = await sinkText();
        const sourceBaseline = await sourceText();

        // --- Step 3: endpoint alive, wire dead ---------------------------
        await press();
        await press();
        await press();
        // The source's own label must keep counting — the endpoint still works
        // on its own; only the wire between them is gone.
        await page.waitForFunction(
            (was) => document.querySelector('[data-source-count]')?.textContent.trim() !== was,
            sourceBaseline,
            { timeout: 5000 }
        );
        // Let any (mistaken) forwarded value land before asserting it didn't.
        await sleep(500);

        const sinkAfter = await sinkText();
        if (sinkAfter !== sinkBaseline) {
            throw new Error(
                'deleting the relationship did not stop the wire — sink still followed the source ' +
                `(baseline "${sinkBaseline}" -> "${sinkAfter}")`
            );
        }
    } finally {
        try { sandbox.teardown(); } catch {}
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
};
