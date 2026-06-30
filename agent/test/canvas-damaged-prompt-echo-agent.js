// Test agent for the canvas-damaged Repair prompt probe.
//
// Receives the dispatch fired when the user clicks Repair on a "Canvas
// is damaged" card and paints the verbatim prompt it received onto the
// canvas — pointing index.json at a component that renders it, so the
// damaged canvas heals into a readout of what arrived. The probe then
// asserts (on visible text) that the dispatched prompt carries the
// repair contract. The agent makes no judgement of its own; the test
// owns the contract.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'canvas-damaged-prompt-echo';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};
const escapeHTML = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CanvasDamagedPromptEchoAgent = () => {
    const currentDebug = { kind: KIND, label: 'Canvas damaged prompt echo (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Canvas damaged prompt echo (test)', command: null,
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
            if (!scope) { reject(new Error(KIND + ': missing scope in prompt')); return; }
            setStatus({ status: 'running', cwd: workingDirectory });
            try {
                // Paint the verbatim prompt onto the canvas and point index.json
                // at it, so the damaged canvas re-renders as a readout the probe
                // can read off the screen.
                const compDir = path.join(scope, 'components', 'dispatched-prompt');
                fs.mkdirSync(compDir, { recursive: true });
                fs.writeFileSync(path.join(compDir, 'component.html'),
                    '<liquidos-component path="components/dispatched-prompt">\n' +
                    '    <pre>' + escapeHTML(prompt) + '</pre>\n' +
                    '</liquidos-component>\n');
                fs.writeFileSync(path.join(scope, 'index.json'),
                    JSON.stringify({ components: ['components/dispatched-prompt/component.html'] }, null, 2) + '\n');
                setStatus({ status: 'waiting' });
                resolve('ok');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            }
        })
    };
};

module.exports = { CanvasDamagedPromptEchoAgent };
