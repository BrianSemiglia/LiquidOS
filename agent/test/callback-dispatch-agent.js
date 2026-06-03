// Test agent for the callback-dispatch probe.
//
// Same interface every other runtime in agent/ implements (registered in
// createRuntimes(), kind selectable via --agent). The implementation is
// scenario-specific: on run(), write the call's prompt + scope to a
// known file inside the workspace so the probe can read it back and
// assert. Does NOT spawn an external process — the dispatch loop is
// what we're testing, not a real LLM.

const fs = require('fs');
const path = require('path');

let host = {
    output: () => {},
    status: () => {}
};

const KIND = 'callback-dispatch-test';
const RESULT_DIR = '.test-agent';
const RESULT_FILE = 'callback-dispatch.json';

const extractScope = (prompt) => {
    const match = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return match ? match[1].trim() : '';
};

const extractPromptBody = (prompt) => {
    const match = String(prompt || '').match(/\n\nPrompt:\n([\s\S]*?)$/);
    return match ? match[1].trim() : '';
};

const configure = (next) => {
    host = {
        output: typeof next?.output === 'function' ? next.output : host.output,
        status: typeof next?.status === 'function' ? next.status : host.status
    };
};

const CallbackDispatchTestAgent = () => {
    const currentDebug = {
        kind: KIND,
        label: 'Callback dispatch (test)',
        command: null,
        status: 'waiting',
        provider: 'test',
        model: null,
        source: 'in-process'
    };

    const setStatus = (next) => {
        Object.assign(currentDebug, next, { at: new Date().toISOString() });
        host.status({ ...currentDebug });
    };

    return {
        kind: KIND,
        label: 'Callback dispatch (test)',
        command: null,
        configureHost: configure,
        isInstalled: () => true,
        initialize: ({ workingDirectory } = {}) => setStatus({ status: 'waiting', cwd: workingDirectory || null }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: (prompt) => prompt,
        runtimePaths: () => [],
        materializeRuntime: () => {},
        run: (prompt, context = {}) => new Promise((resolve, reject) => {
            const workingDirectory = context.workingDirectory || context.canvasPath;
            if (!workingDirectory) {
                reject(new Error(KIND + ': run requires workingDirectory'));
                return;
            }
            setStatus({ status: 'running', cwd: workingDirectory, startedAt: new Date().toISOString() });
            try {
                const dir = path.join(workingDirectory, RESULT_DIR);
                fs.mkdirSync(dir, { recursive: true });
                const record = {
                    at: new Date().toISOString(),
                    scope: extractScope(prompt),
                    promptBody: extractPromptBody(prompt),
                    fullPrompt: String(prompt || ''),
                    canvasPath: context.canvasPath || null
                };
                // Overwrite — the probe wants the single call it triggered, not
                // a running log. The test-specific scope of this agent is what
                // makes one-file overwrite the right move (one click, one call).
                fs.writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify(record, null, 2) + '\n');
                host.output(KIND, '[' + KIND + '] dispatched; scope=' + record.scope + '\n');
                setStatus({ status: 'waiting' });
                resolve('ok');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            }
        })
    };
};

module.exports = {
    CallbackDispatchTestAgent,
    KIND
};
