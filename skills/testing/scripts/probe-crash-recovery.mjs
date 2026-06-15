//
// probe-crash-recovery.mjs
//
// The requirement: when the server comes back from a crash it boots in
// --recovery mode and asks the agent to recover with a specific prompt, and the
// recovery pass commits before it exits (so the app restarts onto a clean tree
// and the next attempt can read what this one did in `git log`). This test pins
// the prompt verbatim (below) and checks the server sends it — {{...}} marks the
// only parts allowed to differ — then checks the commit landed. Recovery is not
// component-specific: the crash names no culprit, and the agent is pointed at
// the git log for what prior attempts did.
//
// The crash-repair stub records the prompt it is handed; we read it back and
// compare. The crash itself is induced the generic way — we write the crash
// marker the server acts on, not reaching into how a crash happens in the
// harness.
//
// Run it:  node run-probe.mjs probe-crash-recovery.mjs
//

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVER = path.join(REPO_ROOT, 'server.js');

// What the server must send the agent, verbatim. {{...}} are the only parts
// free to vary. The server wraps every dispatch in a Scope/Prompt envelope, so
// that's part of the expected prompt too ({{scope}} is the workspace root).
const EXPECTED_RECOVERY_PROMPT =
`Scope:
{{scope}}

Prompt:
The LiquidOS server just crashed and was restarted. Something in this
workspace took the whole server down.

Minimal, transitory changes were made to allow the server to boot again —
just enough to keep the rest of the workspace running, not a real fix. Now
try to fix the underlying issues that caused the crash, if you can. If you
fix one, undo the transitory change that worked around it; if you cannot
fix it safely, leave the transitory change in place so the workspace keeps
booting.

This may not be your first attempt. Check \`git log\` for previous
"LiquidOS did recover from crash" commits and the diffs they made — that
is where earlier attempts left their reasoning. Read it so you don't
repeat a fix that did not work and so you can see what still needs
handling. If the crash continues the server will restart and ask again.

Error:
{{reason}}

Stack:
{{stack}}`;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchesExpected = (actual, expected) =>
    new RegExp('^' + expected.split(/\{\{\w+\}\}/).map(escapeRegExp).join('[\\s\\S]*') + '$')
        .test(String(actual));

export const fixture = null;

export default async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-recovery-'));
    const workspace = path.join(tmpRoot, 'recovery.liquidos');
    fs.mkdirSync(path.join(workspace, 'home'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'home', 'input.json'), JSON.stringify({ components: [] }, null, 2) + '\n');

    try {
        // --- a crash → the recovery prompt, verbatim ---
        fs.writeFileSync(path.join(workspace, '.crash-report.json'), JSON.stringify({
            reason: 'uncaught exception: Cannot read properties of undefined (reading "render")',
            stack: 'TypeError: Cannot read properties of undefined\n    at Object.<anonymous>'
        }, null, 2));
        const recover = spawnSync('node', [SERVER, '--workspace', workspace, '--agent', 'crash-repair-stub', '--port', '0', '--recovery'],
            { stdio: 'pipe', encoding: 'utf8' });
        if (recover.status !== 0) throw new Error('recovery run failed: ' + (recover.stderr || recover.stdout));
        const recoveryPrompt = fs.readFileSync(path.join(workspace, '.recovery-prompt.txt'), 'utf8');
        if (!matchesExpected(recoveryPrompt, EXPECTED_RECOVERY_PROMPT)) {
            throw new Error('recovery prompt did not match the expected prompt. Got:\n' + recoveryPrompt);
        }
        console.log('  ok  a crash boots --recovery and dispatches the recovery prompt, verbatim');

        // --- the recovery pass commits before it exits ---
        // The app restarts the server the moment the recovery process exits, so
        // the agent's work has to be committed by then — both so the restart is
        // onto a clean tree and so the next attempt can read it in `git log`.
        const log = spawnSync('git', ['-C', workspace, 'log', '--format=%B'], { encoding: 'utf8' }).stdout || '';
        if (!/LiquidOS did recover from crash/.test(log)) {
            throw new Error('the recovery pass exited without committing. git log:\n' + log);
        }
        const dirty = (spawnSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }).stdout || '').trim();
        if (dirty) {
            throw new Error('the recovery pass exited with uncommitted changes:\n' + dirty);
        }
        console.log('  ok  the recovery pass commits before it exits (clean tree, recorded in git log)');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
};
