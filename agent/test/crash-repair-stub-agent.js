// Test agent for the crash-recovery flow.
//
// Recovery is two phases, each a dispatch with its own prompt: Phase 1 asks the
// agent to make the workspace bootable, Phase 2 asks a fresh agent to make a
// permanent fix once the server is back up. That the
// server sends each prompt verbatim is the requirement — and it is asserted in
// the test (skills/testing/scripts/probe-crash-recovery.mjs), which holds the
// expected prompts and compares. Neither prompt is component-specific: the crash
// names no culprit, and the agent is pointed at the git log. This stub's only
// job is to record the prompt it was handed for each phase, so the test can
// check it.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'crash-repair-stub';

// One discriminating line per phase. Checking the WHOLE prompt verbatim is the
// test's job. (The server wraps the body in a "Scope:/Prompt:" envelope, so
// don't anchor.)
const RECOVERY = /just crashed and was restarted/;
const FIX = /was made bootable with a minimal/;

const recordPrompt = (workspaceDir, name, prompt) => {
    try { fs.writeFileSync(path.join(workspaceDir, name), String(prompt)); } catch { /* best effort */ }
};

const fileExists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Test hook: when LIQUIDOS_STUB_HOLD names a file, Phase 1 blocks after recording
// its prompt until that file appears. This lets a probe catch the workspace mid
// make-bootable (recovering === true) and assert the server is holding service
// spawns. A timeout keeps it from hanging if the probe never releases it.
const holdUntilReleased = async () => {
    const release = process.env.LIQUIDOS_STUB_HOLD;
    if (!release) return;
    const deadline = Date.now() + 20000;
    while (!fileExists(release) && Date.now() < deadline) await sleep(50);
};

const CrashRepairStubAgent = () => {
    const currentDebug = {
        kind: KIND,
        label: 'crash repair (stub)',
        command: null,
        status: 'waiting',
        provider: 'test',
        model: null,
        source: 'in-process'
    };
    const setStatus = (next) => {
        Object.assign(currentDebug, next, { at: new Date().toISOString() });
        host.status({ ...currentDebug });
    };
    return {
        kind: KIND,
        label: 'crash repair (stub)',
        command: null,
        configureHost: (next) => {
            host = {
                output: typeof next?.output === 'function' ? next.output : host.output,
                status: typeof next?.status === 'function' ? next.status : host.status
            };
        },
        isInstalled: () => true,
        initialize: ({ workingDirectory } = {}) =>
            setStatus({ status: 'waiting', cwd: workingDirectory || null }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: (prompt) => prompt,
        runtimePaths: () => [],
        materializeRuntime: () => {},
        run: async (prompt, context = {}) => {
            const workspaceDir = context.workingDirectory;
            if (!workspaceDir) {
                throw new Error(KIND + ': run requires workingDirectory');
            }
            setStatus({ status: 'running', cwd: workspaceDir });

            if (FIX.test(prompt)) {
                recordPrompt(workspaceDir, '.fix-prompt.txt', prompt);
                setStatus({ status: 'waiting' });
                return 'ok: permanent fix prompt recorded';
            }

            if (RECOVERY.test(prompt)) {
                recordPrompt(workspaceDir, '.recovery-prompt.txt', prompt);
                await holdUntilReleased();
                setStatus({ status: 'waiting' });
                return 'ok: recovery prompt recorded';
            }

            throw new Error(KIND + ': unexpected prompt (neither recovery nor fix):\n' + prompt);
        }
    };
};

module.exports = { CrashRepairStubAgent };
