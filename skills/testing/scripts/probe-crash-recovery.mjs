//
// probe-crash-recovery.mjs
//
// Crash recovery is two phases, both dispatched on a normal boot — there is no
// special server mode:
//   Phase 1 (make it bootable): a crash leaves a marker; the next boot hands the
//     agent the crash and asks for the minimal transitory change, then commits.
//   Phase 2 (make it permanent): once Phase 1 has committed, the queue chains
//     into a fresh dispatch asking the agent to fix the cause for real (in a
//     sandbox) and undo the transitory change, then commits.
//
// This test pins both prompts verbatim (below) and checks the server sends them
// — {{...}} marks the only parts allowed to differ — and that each phase commits
// its attempt to the git timeline (which is the only state the phases use to
// decide what is owed). Neither prompt is component-specific: the crash names no
// culprit, and the agent is pointed at the git log. The crash itself is induced
// the generic way — we write the crash marker the server acts on, not reaching
// into how a crash happens in the harness.
//
// Run it:  node run-probe.mjs probe-crash-recovery.mjs
//

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVER = path.join(REPO_ROOT, 'server.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// What the server must send the agent, verbatim. {{...}} are the only parts free
// to vary. The server wraps every dispatch in a Scope/Prompt envelope, so that's
// part of the expected prompt too ({{scope}} is the workspace root).
const EXPECTED_RECOVERY_PROMPT =
`Scope:
{{scope}}

Prompt:
The LiquidOS server just crashed and was restarted. Something in this
workspace took the whole server down.

Right now your only job is to get the server booting again. Make the
smallest, most transitory change that stops the crash — disable or stub
whatever is taking the server down so the rest of the workspace can run.
This is not the real fix: once the server is back up a follow-up will try
to fix it properly. Keep your change minimal and easy to undo.

This may not be your first attempt. Check \`git log\` for previous
"LiquidOS did recover from crash" commits and the diffs they made — that
is where earlier attempts left their reasoning. Read it so you don't
repeat a fix that did not work. If the crash continues the server will
restart and ask you again.

Error:
{{reason}}

Stack:
{{stack}}`;

const EXPECTED_FIX_PROMPT =
`Scope:
{{scope}}

Prompt:
The LiquidOS server crashed earlier and was made bootable with a minimal,
transitory change — it is running now. Make a permanent fix for the
underlying cause, then undo the transitory change so the workspace is whole
again.

You must do this in a sandbox: a bad fix would crash the live server again,
so reproduce the crash and prove the fix in a sandbox before you touch the
live workspace. See the \`testing\` skill for how to boot a workspace sandbox.
Only once the fix holds in the sandbox: apply it to the live workspace and
undo the transitory change. If you cannot make it safe, leave the transitory
change in place.

Check \`git log\` for the "LiquidOS did recover from crash" commit and its
diff to see what was changed and why, and for any earlier permanent-fix
attempts so you do not repeat one that did not work.`;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchesExpected = (actual, expected) =>
    new RegExp('^' + expected.split(/\{\{\w+\}\}/).map(escapeRegExp).join('[\\s\\S]*') + '$')
        .test(String(actual));

// Run as the mac-app would (LIQUIDOS_RUNTIME_KIND=mac-app) so the server emits
// its LIQUIDOS_RECOVERY stdout lines — the channel the app uses to drive the
// recovery screen. We keep a live stdout buffer so the test can assert them.
const startServer = (workspace, env = {}) => new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER, '--workspace', workspace, '--agent', 'crash-repair-stub', '--port', '0'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LIQUIDOS_RUNTIME_KIND: 'mac-app', ...env } });
    const stdout = { buf: '' };
    proc.stdout.on('data', chunk => { stdout.buf += chunk.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    const timer = setInterval(() => {
        const m = stdout.buf.match(/Server at http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) { clearInterval(timer); resolve({ proc, port: Number(m[1]), stdout }); }
    }, 50);
    setTimeout(() => { clearInterval(timer); reject(new Error('server did not start')); }, 15000);
});

const recoveryStates = (stdout) =>
    [...stdout.buf.matchAll(/LIQUIDOS_RECOVERY (\{[^\n]*\})/g)].map(m => JSON.parse(m[1]).state);

// Stand in for the recovery screen: hold an /agent/stream connection open. The
// server waits for this before running Phase 1 (so the screen sees the agent's
// activity live), so the test must connect just like the app does.
const openAgentStream = (port) => new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/agent/stream`, (res) => {
        res.on('data', () => {});
        resolve(req);
    });
    req.on('error', () => resolve(req));
});

// POST /spawn for a script that does not exist. The server's reply tells us
// whether the spawn gate is closed (recovering) or open: while recovering it
// short-circuits to 200 {deferred} before checking the script; otherwise it
// reaches the existence check and returns 400. So we learn the gate state
// without ever spawning a real process.
const probeSpawnGate = async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: 'home/does-not-exist.js' })
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, deferred: body.deferred === true };
};

const gitLog = (workspace) =>
    spawnSync('git', ['-C', workspace, 'log', '--format=%B'], { encoding: 'utf8' }).stdout || '';

const waitFor = async (predicate, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await sleep(100);
    }
    return await predicate();
};

export const fixture = null;

export default async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-recovery-'));
    const workspace = path.join(tmpRoot, 'recovery.liquidos');
    fs.mkdirSync(path.join(workspace, 'home'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'home', 'index.json'), JSON.stringify({ components: [] }, null, 2) + '\n');

    const procs = [];
    let agentStream = null;
    try {
        // A crash leaves a marker; the next boot must act on it. Booting the
        // server normally (no special mode) is the whole trigger. We arm the
        // stub to hold Phase 1 open (until we drop a release file) so we can
        // catch the workspace mid make-bootable and check the spawn gate.
        const release = path.join(workspace, '.release-recovery');
        fs.writeFileSync(path.join(workspace, '.crash-report.json'), JSON.stringify({
            reason: 'uncaught exception: Cannot read properties of undefined (reading "render")',
            stack: 'TypeError: Cannot read properties of undefined\n    at Object.<anonymous>'
        }, null, 2));
        const { proc, port, stdout } = await startServer(workspace, { LIQUIDOS_STUB_HOLD: release });
        procs.push(proc);

        // Phase 1 must wait for the recovery screen to connect, so the screen
        // sees the agent's activity live. Give it a beat with no client and
        // confirm nothing dispatched yet.
        const recoveryPromptPath = path.join(workspace, '.recovery-prompt.txt');
        await sleep(600);
        if (fs.existsSync(recoveryPromptPath)) {
            throw new Error('Phase 1 ran before the recovery screen connected to /agent/stream');
        }
        console.log('  ok  Phase 1 waits for the recovery screen before dispatching the agent');

        // Connect like the recovery screen does — this is what releases Phase 1.
        agentStream = await openAgentStream(port);

        // --- Phase 1: the crash → the make-bootable prompt, verbatim, committed ---
        if (!await waitFor(() => fs.existsSync(recoveryPromptPath))) {
            throw new Error('a boot with a crash marker never dispatched the make-bootable prompt');
        }
        const recoveryPrompt = fs.readFileSync(recoveryPromptPath, 'utf8');
        if (!matchesExpected(recoveryPrompt, EXPECTED_RECOVERY_PROMPT)) {
            throw new Error('make-bootable prompt did not match the expected prompt. Got:\n' + recoveryPrompt);
        }
        console.log('  ok  a crash marker dispatches the make-bootable prompt, verbatim');

        // While Phase 1 is in flight the server must hold service spawns, or the
        // client would re-spawn the offender and re-crash the server mid-repair.
        const gateDuring = await probeSpawnGate(port);
        if (!(gateDuring.status === 200 && gateDuring.deferred)) {
            throw new Error('service spawns were not held during Phase 1 (got ' + JSON.stringify(gateDuring) + ')');
        }
        console.log('  ok  service spawns are held while Phase 1 is making the workspace bootable');

        // ...and the server tells the app it's recovering, so the app can show
        // the recovery screen (and not yet load the canvas).
        if (!await waitFor(() => recoveryStates(stdout).includes('recovering'))) {
            throw new Error('the server did not report state "recovering". Saw: ' + JSON.stringify(recoveryStates(stdout)));
        }
        console.log('  ok  the server reports "recovering" while Phase 1 is in flight');

        // Release Phase 1 → it commits and the gate reopens.
        fs.writeFileSync(release, '');
        if (!await waitFor(() => /LiquidOS did recover from crash/.test(gitLog(workspace)))) {
            throw new Error('Phase 1 did not commit. git log:\n' + gitLog(workspace));
        }
        console.log('  ok  Phase 1 commits its attempt to the timeline');

        if (!await waitFor(async () => (await probeSpawnGate(port)).status === 400)) {
            throw new Error('the spawn gate did not reopen after Phase 1 committed');
        }
        console.log('  ok  the spawn gate reopens once the workspace is bootable');

        // ...and the server tells the app it's ready, so it loads the canvas.
        if (!await waitFor(() => recoveryStates(stdout).includes('ready'))) {
            throw new Error('the server did not report state "ready". Saw: ' + JSON.stringify(recoveryStates(stdout)));
        }
        console.log('  ok  the server reports "ready" once the workspace is bootable');

        // --- Phase 2: chained off Phase 1 → the permanent-fix prompt, verbatim, committed ---
        const fixPromptPath = path.join(workspace, '.fix-prompt.txt');
        if (!await waitFor(() => fs.existsSync(fixPromptPath))) {
            throw new Error('Phase 1 did not chain into the permanent fix');
        }
        const fixPrompt = fs.readFileSync(fixPromptPath, 'utf8');
        if (!matchesExpected(fixPrompt, EXPECTED_FIX_PROMPT)) {
            throw new Error('permanent-fix prompt did not match the expected prompt. Got:\n' + fixPrompt);
        }
        console.log('  ok  Phase 1 chains into the permanent-fix prompt, verbatim');

        if (!await waitFor(() => /LiquidOS did attempt a permanent fix/.test(gitLog(workspace)))) {
            throw new Error('Phase 2 was not committed. git log:\n' + gitLog(workspace));
        }
        console.log('  ok  Phase 2 commits its attempt (closes the recovery cycle)');
    } finally {
        try { agentStream?.destroy(); } catch {}
        for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
};
