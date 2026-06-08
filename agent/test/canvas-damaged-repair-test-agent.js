// Test agent for the canvas-damaged Repair click probe.
//
// Receives the dispatch fired when the user clicks Repair on a "Canvas
// is damaged" card. The fixture has a broken input.json (entries point
// at components without a component.html file) and a pre-staged
// "canvas-repaired" component carrying [data-canvas-repair-marker].
// The agent's "repair" is just rewriting input.json to reference the
// repaired component so the canvas can render again.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'canvas-damaged-repair-test';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const CanvasDamagedRepairTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Canvas damaged repair (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Canvas damaged repair (test)', command: null,
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

            // Contract check: the canvas-damaged Repair dispatch must
            // give us a canvas-folder scope and a prompt that names the
            // underlying error. On mismatch, write a failure view into
            // the pre-staged repaired component carrying the actual
            // prompt so the probe sees what arrived.
            const expectations = [
                { name: 'Scope header',                       ok: /^Scope:\n\S/m.test(prompt) },
                { name: 'Prompt header',                      ok: /^Prompt:$/m.test(prompt) },
                { name: 'scope ends with a slash (canvas)',   ok: /^Scope:\n[^\n]*\/$/m.test(prompt) },
                { name: 'prompt names the error',             ok: /Repair required due to error:/.test(prompt) }
            ];
            const failed = expectations.filter(e => !e.ok);
            const repairedViewPath = path.join(workingDirectory, 'home', 'components', 'canvas-repaired', 'view.json');

            try {
                if (failed.length > 0) {
                    const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const html =
                        '<div data-canvas-repair-failure>' +
                        '<p>contract failed: ' + escape(failed.map(f => f.name).join(', ')) + '</p>' +
                        '<pre data-prompt-received>' + escape(prompt) + '</pre>' +
                        '</div>';
                    // Surface the failure: rewrite input.json to point at the
                    // pre-staged component AND replace its view.json with
                    // the failure HTML, so the probe sees the diagnostic.
                    fs.writeFileSync(repairedViewPath, JSON.stringify({ title: 'Repair contract failed', html }, null, 2) + '\n');
                } else {
                    // Reset the repaired component's view back to its success
                    // marker (in case a prior run left a failure HTML).
                    fs.writeFileSync(repairedViewPath, JSON.stringify({
                        title: 'Canvas Repaired',
                        html: '<p data-canvas-repair-marker>canvas repaired</p>'
                    }, null, 2) + '\n');
                }
                const inputPath = path.join(scope, 'input.json');
                fs.writeFileSync(inputPath, JSON.stringify({
                    components: ['components/canvas-repaired/component.html']
                }, null, 2) + '\n');
                setStatus({ status: 'waiting' });
                resolve('ok');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            }
        })
    };
};

module.exports = { CanvasDamagedRepairTestAgent };
