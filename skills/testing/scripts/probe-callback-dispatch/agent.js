// Test agent for the callback-dispatch probe.
//
// What a real agent would do for "user clicked something, dispatch agent
// to react": some action that surfaces in the UI. This test agent does
// the smallest deterministic version of that — rewrites the probe
// component's component.html so its <span data-pong> reads "PONG". The
// harness's file watcher picks up the change and re-renders the
// component; the probe asserts the span text in the DOM.
//
// The agent extracts the component scope from the dispatched prompt,
// so the same agent works regardless of where the test fixture puts
// the probe component.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'callback-dispatch-test';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const PONG_HTML = '<button data-probe-btn type="button">Ping</button><span data-pong>PONG</span>';

const CallbackDispatchTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Callback dispatch (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Callback dispatch (test)', command: null,
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
            // Scope is the component folder. Rewrite its component.html with a
            // PONG span so the harness re-renders it and the probe reads the
            // span via the DOM.
            if (!scope.includes('components/')) {
                reject(new Error(KIND + ': scope did not point at a component: ' + scope));
                return;
            }
            setStatus({ status: 'running', cwd: workingDirectory });
            try {
                const rel = scope.slice(scope.indexOf('components/')).replace(/\/+$/, '');
                const compHtmlPath = path.join(scope, 'component.html');
                fs.writeFileSync(compHtmlPath, `<liquidos-component path="${rel}">\n    ${PONG_HTML}\n</liquidos-component>\n`);
                setStatus({ status: 'waiting' });
                resolve('ok');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            }
        })
    };
};

module.exports = { CallbackDispatchTestAgent };
