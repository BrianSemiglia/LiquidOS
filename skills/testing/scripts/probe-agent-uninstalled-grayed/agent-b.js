// Test agent for the uninstalled-grayed probe.
//
// A runtime that is offered as a choice but is not installed: its command
// binary is absent, so isInstalled() returns false. The picker still lists
// it (it's a registered choice), but renders the <option> disabled — the
// grayed-out, unpickable state a user sees for an agent whose CLI isn't on
// the machine. It never dispatches, so run() just rejects; the probe only
// inspects how the choice is presented.

let host = { output: () => {}, status: () => {} };
const KIND = 'uninstalled-stub';
const LABEL = 'Uninstalled Stub';

const UninstalledStubAgent = () => {
    const currentDebug = { kind: KIND, label: LABEL, command: 'uninstalled-stub-binary', status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: LABEL, command: 'uninstalled-stub-binary',
        configureHost: (next) => { host = { output: typeof next?.output === 'function' ? next.output : host.output, status: typeof next?.status === 'function' ? next.status : host.status }; },
        // The whole point of this stub: it is never installed.
        isInstalled: () => false,
        initialize: ({ workingDirectory } = {}) => setStatus({ status: 'waiting', cwd: workingDirectory || null }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: (prompt) => prompt,
        runtimePaths: () => [],
        materializeRuntime: () => {},
        run: () => Promise.reject(new Error(KIND + ': not installed, cannot run'))
    };
};

module.exports = { UninstalledStubAgent, LABEL };
