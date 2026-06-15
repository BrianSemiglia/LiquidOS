// Test agent for the crash-recovery flow.
//
// When the server comes back from a crash it dispatches one recovery prompt.
// That the server sends that prompt verbatim is the requirement — and it is
// asserted in the test (skills/testing/scripts/probe-crash-recovery.mjs), which
// holds the expected prompt and compares. Recovery is not component-specific:
// the crash names no culprit, and the agent is pointed at the git log. This
// stub's only job is to record the prompt it was handed, so the test can check
// it.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'crash-repair-stub';

// One discriminating line to recognize the recovery prompt. Checking the WHOLE
// prompt verbatim is the test's job. (The server wraps the body in a
// "Scope:/Prompt:" envelope, so don't anchor.)
const RECOVERY = /The LiquidOS server just crashed and was restarted/;

const recordPrompt = (workspaceDir, name, prompt) => {
    try { fs.writeFileSync(path.join(workspaceDir, name), String(prompt)); } catch { /* best effort */ }
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

            if (RECOVERY.test(prompt)) {
                recordPrompt(workspaceDir, '.recovery-prompt.txt', prompt);
                setStatus({ status: 'waiting' });
                return 'ok: recovery prompt recorded';
            }

            throw new Error(KIND + ': unexpected prompt (not a recovery prompt):\n' + prompt);
        }
    };
};

module.exports = { CrashRepairStubAgent };
