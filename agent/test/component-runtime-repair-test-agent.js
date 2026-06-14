// Test agent for the component runtime-error Repair click probe.
//
// Receives the dispatch fired when the user clicks the runtime Repair
// button on a component whose functions.js has been throwing. The
// agent's "repair" is to rewrite functions.js to a clean, non-throwing
// mount and rewrite component.html to a known marker so the probe can
// observe the user-visible recovery.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'component-runtime-repair-test';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const ComponentRuntimeRepairTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Component runtime repair (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Component runtime repair (test)', command: null,
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

            // Contract check: a runtime-error Repair dispatch must point
            // at the component's folder and name the underlying error so
            // the agent can act. On mismatch, write a failure view that
            // carries the actual prompt into the DOM — the probe sees
            // it instead of timing out blind.
            const expectations = [
                { name: 'Scope header',                       ok: /^Scope:\n\S/m.test(prompt) },
                { name: 'Prompt header',                      ok: /^Prompt:$/m.test(prompt) },
                { name: 'scope points at runtime-error',      ok: /Scope:\n[^\n]*components\/runtime-error/.test(prompt) },
                { name: 'prompt names the error',             ok: /Repair required due to error:/.test(prompt) },
                { name: 'error mentions the simulated throw', ok: /SIMULATED_RUNTIME_ERROR_FOR_TEST/.test(prompt) }
            ];
            const failed = expectations.filter(e => !e.ok);
            const functionsPath = path.join(scope, 'presented', 'functions.js');
            const rel = scope.slice(scope.indexOf('components/')).replace(/\/+$/, '');
            const compHtmlPath = path.join(scope, 'component.html');

            try {
                if (failed.length > 0) {
                    const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const html =
                        '<div data-runtime-repair-failure>' +
                        '<p>contract failed: ' + escape(failed.map(f => f.name).join(', ')) + '</p>' +
                        '<pre data-prompt-received>' + escape(prompt) + '</pre>' +
                        '</div>';
                    // Still neutralize functions.js (otherwise the throw
                    // keeps firing and the runtime Repair button never
                    // clears, masking the contract failure with a fresh
                    // dispatch loop).
                    fs.writeFileSync(functionsPath, 'export const mount = () => () => {};\n');
                    fs.writeFileSync(compHtmlPath,
                        `<liquidos-component path="${rel}">\n    ${html}\n</liquidos-component>\n`);
                } else {
                    fs.writeFileSync(functionsPath, 'export const mount = () => () => {};\n');
                    fs.writeFileSync(compHtmlPath,
                        `<liquidos-component path="${rel}">\n    <p data-runtime-repair-marker>runtime repaired</p>\n</liquidos-component>\n`);
                }
                setStatus({ status: 'waiting' });
                resolve('ok');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            }
        })
    };
};

module.exports = { ComponentRuntimeRepairTestAgent };
