// Test agent for the prompt-bar probe.
//
// Real agent's job for a canvas-scoped prompt typed in the bottom bar:
// "do what the user said, on this canvas." Test agent does the
// smallest deterministic thing: edits index.json to include the
// pre-staged probe-built component so the probe can observe the new
// component in the DOM.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'prompt-bar-test';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const PromptBarTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Prompt bar (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Prompt bar (test)', command: null,
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
            // Scope is the canvas folder for prompt-bar submissions.
            const canvasFolder = (extractScope(prompt) || '').replace(/\/$/, '');
            if (!canvasFolder) { reject(new Error(KIND + ': could not extract canvas scope')); return; }
            setStatus({ status: 'running', cwd: workingDirectory });
            try {
                const indexPath = path.join(canvasFolder, 'index.json');
                fs.writeFileSync(indexPath, JSON.stringify({ components: ['components/probe-built/component.html'] }, null, 2) + '\n');
                setStatus({ status: 'waiting' });
                resolve('ok');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            }
        })
    };
};

module.exports = { PromptBarTestAgent };
