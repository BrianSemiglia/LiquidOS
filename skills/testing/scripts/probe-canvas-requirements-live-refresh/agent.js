// Per-probe copy for probe-canvas-requirements-live-refresh — its own stub so no two probes share one.
// Test agent for the canvas-repair probe.
//
// Real agent's job on the canvas Repair prompt: find or write
// feature-requirements.txt. This test agent writes a known marker so
// the probe can verify the textarea reflects the change after the
// modal is reopened.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'canvas-requirements-live-refresh';
const MARKER = '- REPAIRED_CANVAS_BY_TEST_AGENT';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const CanvasRequirementsLiveRefreshAgent = () => {
    const currentDebug = { kind: KIND, label: 'Canvas repair (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Canvas repair (test)', command: null,
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
                fs.writeFileSync(path.join(canvasFolder, 'feature-requirements.txt'), MARKER + '\n');
                setStatus({ status: 'waiting' });
                resolve('ok');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            }
        })
    };
};

module.exports = { CanvasRequirementsLiveRefreshAgent, MARKER };
