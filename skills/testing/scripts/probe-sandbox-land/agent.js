// Test agent for the sandbox-land probe.
//
// Exercises the "agent verified a change in a sandbox, now land it into the
// source workspace" flow. The agent stages its files in a throwaway sandbox
// directory, then lands each one into the source workspace through the SAME
// write path the browser uses — PUT /workspace/<path>, one file per call.
// There is no batch/copy/bounds endpoint: the workspace watcher coalesces the
// burst into one refresh, and landing a sandbox file is just "read its bytes,
// PUT them."
//
// The agent learns the source server's origin from the dispatch context
// (context.origin), the same channel that hands it workingDirectory.

const fs = require('fs');
const os = require('os');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'sandbox-land-test';
const MARKER = 'LANDED_BY_SANDBOX_BATCH';
const LANDED_HTML = `<liquidos-component path="components/probe">
    <p data-landed-by-sandbox>${MARKER}</p>
</liquidos-component>
`;

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const putFile = async (origin, rel, body) => {
    const response = await fetch(origin + '/workspace/' + rel, { method: 'PUT', body });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(KIND + ': PUT /workspace/' + rel + ' failed ' + response.status + ': ' + detail);
    }
};

const SandboxLandTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Sandbox land (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Sandbox land (test)', command: null,
        configureHost: (next) => { host = { output: typeof next?.output === 'function' ? next.output : host.output, status: typeof next?.status === 'function' ? next.status : host.status }; },
        isInstalled: () => true,
        initialize: ({ workingDirectory } = {}) => setStatus({ status: 'waiting', cwd: workingDirectory || null }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: (prompt) => prompt,
        runtimePaths: () => [],
        materializeRuntime: () => {},
        run: async (prompt, context = {}) => {
            const workingDirectory = context.workingDirectory || context.canvasPath;
            if (!workingDirectory) throw new Error(KIND + ': run requires workingDirectory');
            const origin = context.origin;
            if (!origin) throw new Error(KIND + ': run requires context.origin');
            const scope = extractScope(prompt);
            if (!scope.includes('/components/')) throw new Error(KIND + ': scope did not point at a component: ' + scope);
            setStatus({ status: 'running', cwd: workingDirectory });

            // Stage the verified change in a throwaway sandbox, exactly as the
            // real flow does after proving it in a sandboxed app.
            const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-land-'));
            try {
                fs.writeFileSync(path.join(sandbox, 'component.html'), LANDED_HTML);

                const componentDir = scope.replace(/\/$/, '');
                const relHtml = path.relative(workingDirectory, path.join(componentDir, 'component.html'));
                const relReq = path.relative(workingDirectory, path.join(componentDir, 'feature-requirements.txt'));

                // Land each file through the workspace PUT endpoint — the copied
                // sandbox file by reading its bytes, the other inline. Two PUTs
                // the watcher coalesces into one refresh.
                await putFile(origin, relHtml, fs.readFileSync(path.join(sandbox, 'component.html')));
                await putFile(origin, relReq, '- ' + MARKER + '\n');

                setStatus({ status: 'waiting' });
                return 'ok';
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                throw error;
            } finally {
                fs.rmSync(sandbox, { recursive: true, force: true });
            }
        }
    };
};

module.exports = { SandboxLandTestAgent, MARKER };
