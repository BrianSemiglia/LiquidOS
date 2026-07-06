// Test agent A for the agent-switch probe.
//
// Half of a pair (see agent-switch-stub-b-agent.js) used to prove the user can
// switch the active agent through the dropdown and that the *selected* runtime
// is the one that actually dispatches. On a canvas-scoped prompt this stub does
// the smallest deterministic, self-contained thing: it writes its own component
// (a unique on-screen marker) and points the canvas index.json at it. Switching
// to stub B and dispatching again replaces the marker with B's — visible proof
// the active runtime changed.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'stub-a';
const LABEL = 'Stub A';
const STUB_A_REPLY = 'STUB_A_REPLY';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const AgentSwitchStubAAgent = () => {
    const currentDebug = { kind: KIND, label: LABEL, command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: LABEL, command: null,
        configureHost: (next) => { host = { output: typeof next?.output === 'function' ? next.output : host.output, status: typeof next?.status === 'function' ? next.status : host.status }; },
        isInstalled: () => true,
        initialize: ({ workingDirectory } = {}) => setStatus({ status: 'waiting', cwd: workingDirectory || null }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: (prompt) => prompt,
        runtimePaths: () => [],
        materializeRuntime: () => {},
        run: (prompt, context = {}) => new Promise((resolve, reject) => {
            const workingDirectory = context.workingDirectory || context.canvasPath;
            if (!workingDirectory) { reject(new Error(KIND + ': run requires workingDirectory')); return; }
            const canvasFolder = (extractScope(prompt) || '').replace(/\/$/, '');
            if (!canvasFolder) { reject(new Error(KIND + ': could not extract canvas scope')); return; }
            setStatus({ status: 'running', cwd: workingDirectory });
            try {
                const componentDir = path.join(canvasFolder, 'components', KIND);
                fs.mkdirSync(componentDir, { recursive: true });
                fs.writeFileSync(
                    path.join(componentDir, 'component.html'),
                    '<liquidos-component path="components/' + KIND + '">\n'
                    + '    <p data-agent-switch-marker>' + STUB_A_REPLY + '</p>\n'
                    + '</liquidos-component>\n'
                );
                fs.writeFileSync(
                    path.join(canvasFolder, 'index.json'),
                    JSON.stringify({ components: ['components/' + KIND + '/component.html'] }, null, 2) + '\n'
                );
                setStatus({ status: 'waiting' });
                resolve('ok');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            }
        })
    };
};

module.exports = { AgentSwitchStubAAgent, STUB_A_REPLY };
