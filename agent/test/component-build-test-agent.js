// Test agent for the component-build probe.
//
// Simulates the Build dispatch (user edited requirements, clicked Build,
// the harness dispatched the agent to update the implementation). The
// agent's "update" is just writing a known marker into the component's
// view.json so the probe can observe the user-visible result through
// the DOM, not by reading internal files.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'component-build-test';
const MARKER_HTML = '<p data-built-by-test>built-by-component-build-test</p>';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const ComponentBuildTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Component build (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Component build (test)', command: null,
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

            // Contract check: the Build dispatch must hand the agent
            // every part of the documented prompt — scope, component,
            // before/after requirements, the guidance lines. On any
            // mismatch, write a failure view.json that carries the
            // actual prompt into the DOM, so the probe sees what the
            // agent received without ever reading internal files.
            //
            // The probe pre-seeds feature-requirements.txt with
            // "BEFORE_PROBE_MARKER" and types
            // "AFTER_PROBE_MARKER" into the textarea, so both
            // before and after are observable strings.
            const expectations = [
                { name: 'Scope header',                       ok: /^Scope:\n\S/m.test(prompt) },
                { name: 'Scope points at probe component',    ok: /Scope:\n[^\n]*components\/probe/.test(prompt) },
                { name: 'Prompt header',                      ok: /^Prompt:$/m.test(prompt) },
                { name: 'opening line',                       ok: /The user edited the feature requirements for this component\./.test(prompt) },
                { name: 'Component section',                  ok: /Component:\n[^\n]*components\/probe/.test(prompt) },
                { name: 'Previous requirements section',      ok: /Previous requirements:/.test(prompt) },
                { name: 'Previous carries the before text',   ok: /Previous requirements:\n[^\n]*BEFORE_PROBE_MARKER/.test(prompt) },
                { name: 'Updated requirements section',       ok: /Updated requirements:/.test(prompt) },
                { name: 'Updated carries the after text',     ok: /Updated requirements:\n[^\n]*AFTER_PROBE_MARKER/.test(prompt) },
                { name: 'before precedes after',              ok: prompt.indexOf('Previous requirements:') < prompt.indexOf('Updated requirements:') },
                { name: 'guidance: review before changing',   ok: /Review the actual component before changing anything\./.test(prompt) },
                { name: 'guidance: keep user-facing',         ok: /Keep feature-requirements\.txt user-facing/.test(prompt) },
                { name: 'guidance: resolve mismatch',         ok: /resolve the mismatch by updating the implementation, the requirements, or both/.test(prompt) },
                { name: 'guidance: no unrelated capabilities',ok: /Do not add unrelated capabilities/.test(prompt) }
            ];
            const failed = expectations.filter(e => !e.ok);
            const viewPath = path.join(scope, 'view.json');

            try {
                if (failed.length > 0) {
                    const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const html =
                        '<div data-built-failure>' +
                        '<p>contract failed: ' + escape(failed.map(f => f.name).join(', ')) + '</p>' +
                        '<pre data-prompt-received>' + escape(prompt) + '</pre>' +
                        '</div>';
                    fs.writeFileSync(viewPath, JSON.stringify({ title: 'Build failed', html }, null, 2) + '\n');
                } else {
                    fs.writeFileSync(viewPath, JSON.stringify({ title: 'Built', html: MARKER_HTML }, null, 2) + '\n');
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

module.exports = { ComponentBuildTestAgent };
