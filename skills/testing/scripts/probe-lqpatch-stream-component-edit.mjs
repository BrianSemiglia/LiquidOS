#!/usr/bin/env node
//
// probe-lqpatch-stream-component-edit.mjs
//
// The combined wiring test:
//
//   prompt → POST /output
//          → harness queue
//          → lqpatch-stream-stub agent
//          → host.output(chunks containing <lqpatch> markers)
//          → /agent/stream SSE
//          → index.html sniffer (lib/lqpatch-sniffer.js)
//          → atomic + stream + writeFile dispatches
//          → PUT /workspace/<file>
//          → component's view.json on disk changes
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
    const viewPath = path.join(sandbox.workspace, 'home/components/target/view.json');
    const baseline = fs.readFileSync(viewPath, 'utf8');
    expect('baseline view.json has MARKER_BEFORE',
        baseline.includes('MARKER_BEFORE'),
        'fixture is corrupted');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for the sniffer module to initialize the global state.
    await page.waitForFunction(() => !!window.__lqpatch, undefined, { timeout: 10000 });

    const token = 'STREAM_' + Math.random().toString(36).slice(2, 10).toUpperCase();
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

    // Wait for the writeFile op to land — both client (state.writeFiles
    // populated) and disk (view.json contains the token).
    const deadline = Date.now() + 20000;
    let after = '';
    let state = null;
    while (Date.now() < deadline) {
        after = fs.readFileSync(viewPath, 'utf8');
        state = await page.evaluate(() => {
            const marker = document.getElementById('lqpatch-marker');
            const invented = document.querySelector('#lqpatch-marker .agent-invented');
            return {
                narration: window.__lqpatch.narration,
                dispatches: window.__lqpatch.dispatches.slice(),
                rejects: window.__lqpatch.rejects.slice(),
                writeFiles: window.__lqpatch.writeFiles.slice(),
                streamMutations: window.__lqpatch.streamMutations,
                sinkInner: document.getElementById('lqpatch-sink').innerHTML,
                sinkText: document.getElementById('lqpatch-sink').textContent,
                markerExists: !!marker,
                inventedInsideMarker: !!invented && marker && marker.contains(invented),
                inventedTag: invented ? invented.dataset.tag : null
            };
        });
        if (after.includes(token)
            && state.writeFiles.length > 0
            && state.narration.includes('Done!')) break;
        await sleep(150);
    }

    // --- file on disk -------------------------------------------------
    if (after.includes('MARKER_BEFORE')) {
        console.log('\n  --- diagnostic dump ---');
        console.log('  narration (' + state.narration.length + ' chars):',
            JSON.stringify(state.narration.slice(0, 200)));
        console.log('  dispatches:', JSON.stringify(state.dispatches));
        console.log('  rejects:', JSON.stringify(state.rejects));
        console.log('  writeFiles:', JSON.stringify(state.writeFiles));
        console.log('  streamMutations:', state.streamMutations);
        console.log('  sinkInner:', state.sinkInner.slice(0, 200));
    }
    expect('MARKER_BEFORE is gone after dispatch',
        !after.includes('MARKER_BEFORE'),
        'writeFile op never reached disk — file still: ' + after.slice(0, 200));
    expect('token from prompt landed in view.json on disk',
        after.includes(token),
        'got: ' + after.slice(0, 200));

    // --- narration --------------------
    expect('narration: opening prose',
        state.narration.includes("Here's a small build."),
        'got: ' + state.narration.slice(0, 200));
    expect('narration: trailing "Done!" lands (end-flush regression)',
        state.narration.includes('Done!'),
        'tail not flushed — narration ends with: ' + state.narration.slice(-80));
    expect('narration: no <lqpatch> leaked into prose',
        !state.narration.includes('<lqpatch'),
        'patch open tag escaped the sniffer');

    // --- atomic + stream dispatches ---
    const dispatched = state.dispatches.map(d => d.op);
    expect('dispatches: replace on #lqpatch-sink',
        state.dispatches.some(d => d.op === 'replace' && d.target === '#lqpatch-sink'));
    // Streaming proof for op="replace" / op="append": the consumer
    // records `chunks` for every dispatch — the number of times its
    // appendChunk handler fired. > 1 proves the harness rewrote the
    // target progressively as the agent's body arrived, instead of
    // buffering the whole body and applying it atomically at the close
    // tag. Caught the previous gothic-restyle regression where a 3KB
    // op="append" stylesheet landed as a single jump.
    expect('op="replace" streamed (chunks > 1)',
        state.dispatches.some(d => d.op === 'replace' && d.chunks > 1),
        'dispatches: ' + JSON.stringify(state.dispatches.filter(d => d.op === 'replace')));
    expect('op="append" streamed (chunks > 1)',
        state.dispatches.some(d => d.op === 'append' && d.chunks > 1),
        'dispatches: ' + JSON.stringify(state.dispatches.filter(d => d.op === 'append')));
    expect('dispatches: stream-open + stream-close on #lqpatch-sink',
        dispatched.includes('stream-open') && dispatched.includes('stream-close'));
    expect('dispatches: writeFile on home/components/target/view.json',
        state.dispatches.some(d => d.op === 'writeFile'
            && d.target === 'home/components/target/view.json'));
    expect('rejects: empty',
        state.rejects.length === 0,
        'got: ' + JSON.stringify(state.rejects));

    // --- streaming arrived in chunks (MutationObserver proof) ---------
    expect('op=stream arrived in chunks, not one atomic write',
        state.streamMutations >= 3,
        'observed ' + state.streamMutations + ' mutations');

    // --- DOM landed
    expect('sink got the replace marker',
        state.sinkInner.includes('id="lqpatch-marker"'),
        'sink innerHTML: ' + state.sinkInner.slice(0, 200));
    expect('sink got the streamed text including the token',
        state.sinkText.includes(token),
        'sink text: ' + state.sinkText.slice(0, 200));

    // --- streamFile (no agent-side repetition) ----------------------
    // The stub stream contains an op="streamFile" patch whose inner is
    // sent ONCE in the agent's output. The sniffer PATCHes chunks onto
    // the file as they arrive — file content == what the agent typed.
    const streamFilePath = path.join(sandbox.workspace, 'home/components/target/streamed.txt');
    const streamFileExpected =
        'streamed-' + token + ' — the agent never repeated this content in its output.';
    const streamDeadline = Date.now() + 8000;
    let streamFileOnDisk = '';
    while (Date.now() < streamDeadline) {
        try { streamFileOnDisk = fs.readFileSync(streamFilePath, 'utf8'); }
        catch { streamFileOnDisk = ''; }
        if (streamFileOnDisk === streamFileExpected) break;
        await sleep(120);
    }
    expect('streamFile: file exists on disk', streamFileOnDisk.length > 0,
        'streamed file never appeared');
    expect('streamFile: contents equal what the agent emitted, byte-for-byte',
        streamFileOnDisk === streamFileExpected,
        'expected ' + JSON.stringify(streamFileExpected) +
        ', got ' + JSON.stringify(streamFileOnDisk));
    expect('streamFile: streamFile-open + streamFile-close logged',
        state.dispatches.some(d => d.op === 'streamFile-open'
            && d.target === 'home/components/target/streamed.txt')
        && state.dispatches.some(d => d.op === 'streamFile-close'
            && d.target === 'home/components/target/streamed.txt'
            && d.bytes === streamFileExpected.length),
        'missing streamFile open/close or wrong byte count');
    // The actual streaming-proof assertion: the file was assembled from
    // multiple chunks, not landed as one atomic write. If chunks == 1,
    // the agent wrote the whole body in a single host.output call — that
    // works but isn't streamed. Real LLM streaming produces many chunks.
    const closeEvt = state.dispatches.find(d => d.op === 'streamFile-close'
        && d.target === 'home/components/target/streamed.txt');
    expect('streamFile: assembled from >1 chunk (real streaming, not atomic)',
        closeEvt && closeEvt.chunks > 1,
        'streamFile session had ' + (closeEvt && closeEvt.chunks) + ' chunks');

    // --- agent-invented selector ------------------------------------
    // The same stream contains an op="append" against an ID (#lqpatch-marker)
    // that the agent itself created moments earlier with op="replace".
    // This is the unblock: the agent can invent its own selectors and
    // target them in the same turn — no preset allow-list, no pre-defined
    // component hooks.
    const inventedTag = 'invented-' + token;
    expect('append: dispatched against agent-invented selector',
        state.dispatches.some(d => d.op === 'append' && d.target === '#lqpatch-marker'),
        'no append on #lqpatch-marker — got: ' + JSON.stringify(state.dispatches));
    expect('marker exists in DOM after the replace',
        state.markerExists,
        'replace did not create #lqpatch-marker');
    expect('appended span lives INSIDE the just-invented marker',
        state.inventedInsideMarker,
        'append landed outside #lqpatch-marker or not at all');
    expect('appended span carries the prompt token',
        state.inventedTag === inventedTag,
        'got tag: ' + state.inventedTag + ' (expected ' + inventedTag + ')');

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error(e.message);
    exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
