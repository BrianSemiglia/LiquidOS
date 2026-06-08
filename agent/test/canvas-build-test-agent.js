// Test agent for the canvas-build probe.
//
// Simulates what a real agent would do for a canvas reconcile prompt:
// add a component to the canvas. The fixture pre-stages a
// `components/probe-built/` folder; this agent just edits input.json
// to reference it. The harness's file watcher re-renders the canvas,
// the new component surfaces with a [data-canvas-build-marker] element the
// probe asserts on.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'canvas-build-test';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const CanvasBuildTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Canvas build (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Canvas build (test)', command: null,
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
            // The reconcile prompt's scope is the canvas folder. The probe-
            // built component is pre-staged in the fixture, so this agent
            // just adds it to input.json.
            const canvasFolder = (extractScope(prompt) || '').replace(/\/$/, '');
            if (!canvasFolder) {
                reject(new Error(KIND + ': could not extract canvas scope from prompt'));
                return;
            }
            setStatus({ status: 'running', cwd: workingDirectory });
            try {
                const inputPath = path.join(canvasFolder, 'input.json');
                fs.writeFileSync(inputPath, JSON.stringify({ components: ['components/probe-built/component.html'] }, null, 2) + '\n');
                setStatus({ status: 'waiting' });
                resolve('ok');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            }
        })
    };
};

module.exports = { CanvasBuildTestAgent };
