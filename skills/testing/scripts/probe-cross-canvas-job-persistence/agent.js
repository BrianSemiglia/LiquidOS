// Test agent for the cross-canvas job persistence probe.
//
// Simulates a real agent's "think time" with a 2-second delay before
// writing index.json. The delay gives the probe room to:
//   1. dispatch a prompt on canvas A,
//   2. switch to canvas B while the job is still queued/running,
//   3. switch back to canvas A,
// and then observe that the agent's result still landed on canvas A.
//
// If the queue is reset on canvas switch (the bug this probe guards
// against), the pending job vanishes during step 2 and the agent's
// writes never happen. With a self-contained queue, the job runs to
// completion against canvas A's folder regardless of which canvas is
// active when the dispatch fires.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'cross-canvas-persistence-test';
const DELAY_MS = 2000;

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const CrossCanvasPersistenceTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Cross-canvas persistence (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Cross-canvas persistence (test)', command: null,
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
            setTimeout(() => {
                try {
                    const indexPath = path.join(canvasFolder, 'index.json');
                    fs.writeFileSync(indexPath, JSON.stringify({ components: ['components/probe-built/component.html'] }, null, 2) + '\n');
                    setStatus({ status: 'waiting' });
                    resolve('ok');
                } catch (error) {
                    setStatus({ status: 'failed', error: error.message });
                    reject(error);
                }
            }, DELAY_MS);
        })
    };
};

module.exports = { CrossCanvasPersistenceTestAgent };
