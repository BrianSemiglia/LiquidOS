// Test agent for the prompt-bar single-dispatch probe.
//
// Tracks how many times it's been invoked. On the first invocation it
// writes a success marker into the counter component. On any subsequent
// invocation it writes a failure marker — proof that the prompt bar
// double-dispatched a single user submit.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'prompt-bar-single-dispatch-test';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const PromptBarSingleDispatchTestAgent = () => {
    let invocations = 0;
    const currentDebug = { kind: KIND, label: 'Prompt-bar single dispatch (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Prompt-bar single dispatch (test)', command: null,
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
            invocations += 1;
            setStatus({ status: 'running', cwd: workingDirectory });
            try {
                // The fixture's counter component renders its view.json.
                // Write a marker into it so the probe observes the
                // dispatch count via the DOM.
                const viewPath = path.join(workingDirectory, 'home', 'components', 'counter', 'view.json');
                if (invocations === 1) {
                    fs.writeFileSync(viewPath, JSON.stringify({
                        title: 'Counter',
                        html: '<p data-dispatched-once>dispatched once</p>'
                    }, null, 2) + '\n');
                } else {
                    fs.writeFileSync(viewPath, JSON.stringify({
                        title: 'Counter',
                        html: '<p data-dispatched-twice>dispatched ' + invocations + ' times — prompt-bar double-fired</p>'
                    }, null, 2) + '\n');
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

module.exports = { PromptBarSingleDispatchTestAgent };
