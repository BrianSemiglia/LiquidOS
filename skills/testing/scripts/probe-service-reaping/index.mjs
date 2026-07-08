//
// probe-service-reaping
//
// Spawned workers (component services, and the agent — which itself spawns
// sandbox servers) must not outlive the server. This checks that by observing
// only the OS process table — the externally visible behavior — never the
// server's internals. A worker here is a launcher that execs a long-lived
// node process which spawns one child, so there's a real 2-level subtree to
// reap (the agent's shape).
//
// Three behaviors:
//   1. Clean shutdown (SIGTERM): the server takes its whole subtree down.
//   2. Hard kill (SIGKILL): the subtree is orphaned (nothing can run on the
//      way down) — the leak we're guarding against.
//   3. Startup reap: the NEXT server for that workspace kills the strays from
//      (2) before it gets going.
//
// Self-managed (no fixture / browser): it scaffolds a throwaway workspace and
// drives real liquidos-server processes.
//
// Run it:  node run-probe.mjs probe-service-reaping
//

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const fixture = null; // self-managed

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(scriptsDir, '..', '..', '..', '..');
const SERVER = path.join(ROOT, 'go-server', 'liquidos-server');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
});

const waitFor = async (label, fn, timeoutMs = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await fn()) return;
        await sleep(150);
    }
    throw new Error('timed out waiting for: ' + label);
};

const httpPost = (port, p, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
        let buf = ''; res.on('data', d => buf += d); res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data); req.end();
});

// The only thing we inspect: how many live processes are the test's workers.
const workerPids = (workerJs) => {
    try {
        const out = childProcess.execFileSync('pgrep', ['-f', workerJs], { encoding: 'utf8' });
        return out.split('\n').map(s => Number(s.trim())).filter(Boolean);
    } catch { return []; } // pgrep exits non-zero when there are no matches
};

const scaffold = () => {
    const ws = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reaping-')), 'ws.liquidos');
    const home = path.join(ws, 'home');
    const svc = path.join(home, 'svc');
    fs.mkdirSync(svc, { recursive: true });
    fs.writeFileSync(path.join(home, 'index.json'), JSON.stringify({ components: [] }));
    fs.writeFileSync(path.join(home, 'canvas.js'),
        'export default (root) => ({ place() {}, teardown() { root.innerHTML = ""; } });\n');
    // worker.js: a long-lived process that spawns ONE child copy, so /spawn
    // gives us server → worker → grandchild — the agent's subtree shape.
    fs.writeFileSync(path.join(svc, 'worker.js'),
        'if (process.argv[2] !== "child") {\n' +
        '    require("child_process").spawn(process.execPath, [__filename, "child"], { stdio: "ignore" });\n' +
        '}\n' +
        'setInterval(() => {}, 1e9);\n');
    const runSh = path.join(svc, 'run.sh');
    fs.writeFileSync(runSh, '#!/bin/sh\nexec node "$(dirname "$0")/worker.js"\n');
    fs.chmodSync(runSh, 0o755);
    return { ws, workerJs: path.join(svc, 'worker.js') };
};

// Resolve when the server announces it's listening — the signal it actually
// emits — rather than polling on a timer. (Boot does git init + libp2p setup,
// so the time varies; we wait for the event, not a guess.) The timeout is only
// a failure bound.
const startServer = (ws, port) => new Promise((resolve, reject) => {
    const child = childProcess.spawn(SERVER, ['--workspace', ws, '--agent', path.join(ROOT, 'agent/none-agent.js'), '--port', String(port)],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', settled = false;
    const ready = 'Server at http://127.0.0.1:' + port;
    const onData = d => {
        log += d;
        if (!settled && log.includes(ready)) { settled = true; resolve(child); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => { if (!settled) { settled = true; reject(new Error('server exited before listening\n' + log.slice(-1500))); } });
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('server never announced listening\n' + log.slice(-1500))); } }, 30000);
});

const spawnWorker = async (port) => {
    await waitFor('worker spawned', async () => {
        const r = await httpPost(port, '/spawn', { script: 'home/svc/run.sh', label: 'reaping-worker' });
        // /spawn defers while a workspace is mid crash-recovery — retry.
        return r.status === 200 && !JSON.parse(r.body || '{}').deferred;
    }, 15000);
};

const waitExit = (child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.on('exit', () => resolve());
});

export default async () => {
    const { ws, workerJs } = scaffold();
    const spawned = [];
    const cleanup = () => {
        for (const c of spawned) { try { process.kill(c.pid, 'SIGKILL'); } catch {} }
        for (const pid of workerPids(workerJs)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        try { fs.rmSync(path.dirname(ws), { recursive: true, force: true }); } catch {}
    };

    try {
        // --- 1. clean shutdown (SIGTERM) reaps the whole subtree ---------
        const port1 = await freePort();
        const s1 = await startServer(ws, port1); spawned.push(s1);
        await spawnWorker(port1);
        await waitFor('worker subtree up', async () => workerPids(workerJs).length >= 2);
        console.log('worker subtree up:', workerPids(workerJs).length, 'processes');

        s1.kill('SIGTERM');
        await waitExit(s1);
        await waitFor('subtree reaped on clean shutdown', async () => workerPids(workerJs).length === 0, 8000)
            .catch(() => { throw new Error('clean shutdown left ' + workerPids(workerJs).length + ' worker(s) alive'); });
        console.log('1. clean shutdown: subtree reaped');

        // --- 2. hard kill (SIGKILL) orphans the subtree ------------------
        const port2 = await freePort();
        const s2 = await startServer(ws, port2); spawned.push(s2);
        await spawnWorker(port2);
        await waitFor('worker subtree up (2)', async () => workerPids(workerJs).length >= 2);

        s2.kill('SIGKILL');
        await waitExit(s2);
        // Detached workers don't depend on the server, so the moment it's gone
        // they're observably still here — no settle delay needed.
        const orphaned = workerPids(workerJs).length;
        if (orphaned === 0) throw new Error('expected the subtree to survive a SIGKILL (sanity check) but found none');
        console.log('2. hard kill: subtree orphaned as expected (' + orphaned + ' alive)');

        // --- 3. the next server reaps the strays on startup --------------
        const port3 = await freePort();
        const s3 = await startServer(ws, port3); spawned.push(s3);
        await waitFor('strays reaped on startup', async () => workerPids(workerJs).length === 0, 8000)
            .catch(() => { throw new Error('next server did not reap ' + workerPids(workerJs).length + ' stray worker(s) on startup'); });
        console.log('3. startup reap: strays cleared by the next server');

        s3.kill('SIGTERM');
        await waitExit(s3);
    } finally {
        cleanup();
    }
};
