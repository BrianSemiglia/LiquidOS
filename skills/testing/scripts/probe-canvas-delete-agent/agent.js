// Test agent for the canvas-delete (agent path) probe.
//
// Simulates an agent that deletes a canvas: on dispatch it runs the shared
// `delete-canvas` subcommand of the server binary — the exact tool
// skills/canvas/scripts/delete-instance.sh wraps and the DELETE /canvases/<name>
// endpoint runs (deleteCanvasWithTimeline) — to remove a pre-staged 'doomed'
// canvas. The workspace watcher sees the folder vanish and fires
// canvases-changed, so the grid drops the card; the probe asserts that
// disappearance through the UI.
//
// Running the real tool (not an in-process shortcut) is the point: it proves the
// agent path and the UI path delete through one shared implementation.

const path = require('path');
const { spawnSync } = require('child_process');

let host = { output: () => {}, status: () => {} };
const KIND = 'canvas-delete-test';
const TARGET = 'doomed';

const extractScope = prompt => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const CanvasDeleteTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Canvas delete (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = next => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Canvas delete (test)', command: null,
        configureHost: next => { host = { output: typeof next?.output === 'function' ? next.output : host.output, status: typeof next?.status === 'function' ? next.status : host.status }; },
        isInstalled: () => true,
        initialize: ({ workingDirectory } = {}) => setStatus({ status: 'waiting', cwd: workingDirectory || null }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: prompt => prompt,
        runtimePaths: () => [],
        materializeRuntime: () => {},
        run: (prompt, context = {}) => new Promise((resolve, reject) => {
            // The prompt is dispatched on the current canvas; that scope folder's
            // parent is the workspace, which also holds the canvas to delete.
            const scope = (extractScope(prompt) || context.canvasPath || context.workingDirectory || '').replace(/\/$/, '');
            const workspace = path.dirname(scope);
            if (!scope || !workspace) {
                reject(new Error(KIND + ': could not derive workspace from prompt scope'));
                return;
            }
            setStatus({ status: 'running', cwd: workspace });
            const bin = path.join(__dirname, '..', '..', '..', '..', 'go-server', 'liquidos-server');
            const result = spawnSync(bin, ['delete-canvas', TARGET, workspace], { encoding: 'utf8' });
            if (result.status !== 0) {
                const detail = (result.stderr || result.error?.message || 'unknown').trim();
                setStatus({ status: 'failed', error: detail });
                reject(new Error(KIND + ': delete-canvas failed: ' + detail));
                return;
            }
            setStatus({ status: 'waiting' });
            resolve('ok');
        })
    };
};

module.exports = { CanvasDeleteTestAgent };
