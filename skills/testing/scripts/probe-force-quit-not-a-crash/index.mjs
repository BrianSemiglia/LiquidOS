//
// probe-force-quit-not-a-crash
//
// Force-quitting the macOS app SIGKILLs it, which is uncatchable — so the app
// never runs the clean shutdown that would stop the server. The orphaned
// server's next write to its now-readerless stdout (a service forwarding
// output, a log line) fails with EPIPE. That is NOT a workspace crash: nothing
// the agent built took the server down, the GUI just went away. So the server
// must NOT leave a .crash-report.json for it — otherwise the next launch boots
// straight into a phantom crash recovery (see canvas/crash-recovery.js).
//
// We reproduce that exactly, at the mechanism (the one thing the crash-recovery
// probe deliberately doesn't touch, because here the mechanism IS the bug):
// boot the server, close the read end of its stdout (the app going away), poke
// it so it writes and the EPIPE actually fires, then assert it went down via
// EPIPE WITHOUT recording a crash marker.
//
// Run it:  node run-probe.mjs probe-force-quit-not-a-crash
//

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SERVER = path.join(REPO_ROOT, 'server.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const waitFor = async (predicate, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await sleep(50);
    }
    return await predicate();
};

export const fixture = null;

export default async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'force-quit-'));
    const workspace = path.join(tmpRoot, 'force-quit.liquidos');
    fs.mkdirSync(path.join(workspace, 'home'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'home', 'index.json'), JSON.stringify({ components: [] }, null, 2) + '\n');
    const markerPath = path.join(workspace, '.crash-report.json');

    let proc = null;
    try {
        // Boot the server the way the app does. Its stdout/stderr are pipes whose
        // read ends live here — this process stands in for the macOS app.
        proc = spawn('node', [SERVER, '--workspace', workspace, '--agent', path.join(REPO_ROOT, 'agent/none-agent.js'), '--port', '0'],
            { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LIQUIDOS_RUNTIME_KIND: 'mac-app' } });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', c => { stdout += c.toString(); });
        proc.stderr.on('data', c => { stderr += c.toString(); });
        let exitCode;
        proc.on('exit', code => { exitCode = code; });

        // Wait until the server is up — once it has printed its address, its
        // boot-time stdout writes are done.
        let port = null;
        await waitFor(() => {
            const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
            if (m) port = Number(m[1]);
            return port !== null;
        });
        if (port === null) throw new Error('the server never started. stderr:\n' + stderr);

        // Force-quit: the app vanishes. We model the uncatchable SIGKILL — which
        // never lets the app stop the server — by closing the read end of the
        // server's stdout. The server stays alive, now writing into a dead pipe.
        proc.stdout.destroy();

        // The orphaned server's next stdout write fails with EPIPE. POST /output
        // logs a line ('received ... prompt'), guaranteeing that write.
        await fetch(`http://127.0.0.1:${port}/output`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'force a server-side log line' })
        }).catch(() => {});

        // The EPIPE should take the server down.
        if (!await waitFor(() => exitCode !== undefined)) {
            throw new Error('the server did not exit after its stdout reader went away');
        }

        // Guard against a vacuous pass: confirm we actually reproduced the EPIPE
        // path. The crash handler logs the error to stderr before deciding
        // whether to record it, so an EPIPE genuinely occurred.
        if (!/EPIPE/.test(stderr)) {
            throw new Error('expected the server to hit EPIPE on its readerless stdout. stderr:\n' + stderr);
        }
        console.log('  ok  a readerless stdout takes the orphaned server down with EPIPE');

        // The contract: an EPIPE is the app going away, not a workspace crash, so
        // no marker — otherwise the next launch boots into a phantom recovery.
        if (fs.existsSync(markerPath)) {
            throw new Error(
                'the server wrote a crash marker for an EPIPE; the next launch would boot ' +
                'into a phantom recovery. .crash-report.json:\n' + fs.readFileSync(markerPath, 'utf8'));
        }
        console.log('  ok  no crash marker is left for a force-quit (EPIPE), so no phantom recovery');
    } finally {
        try { proc?.kill('SIGKILL'); } catch {}
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
};
