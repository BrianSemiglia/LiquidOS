// Test agent for the component-repair probe.
//
// Simulates what a real agent would do for the Repair find-or-create
// prompt: write a fresh feature-requirements.txt. The probe closes and
// reopens the flip-back; the harness re-fetches /component/.../features
// (no longer cached) and the textarea reflects the agent's write.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'component-repair-test';
const MARKER = '- REPAIRED_BY_TEST_AGENT';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const ComponentRepairTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Component repair (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Component repair (test)', command: null,
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
            const scope = extractScope(prompt);
            if (!scope.includes('/components/')) {
                reject(new Error(KIND + ': scope did not point at a component: ' + scope));
                return;
            }
            setStatus({ status: 'running', cwd: workingDirectory });
            try {
                const reqPath = path.join(scope, 'presented', 'feature-requirements.txt');
                fs.writeFileSync(reqPath, MARKER + '\n');
                setStatus({ status: 'waiting' });
                resolve('ok');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            }
        })
    };
};

module.exports = { ComponentRepairTestAgent, MARKER };
