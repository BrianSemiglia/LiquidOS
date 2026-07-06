// Per-probe copy for probe-debug-output — its own stub so no two probes share one.
//
// Real Claude's job for this flow: as it works, its raw stdout is streamed to
// the host via host.output(kind, chunk). The server splits that into lines and
// feeds them to the debug rail (#debug-output), both as a snapshot and as live
// `debug-line` SSE frames. The stub does exactly that deterministically: it
// reads "REPLACE_WITH: <token>" from the prompt and prints a line carrying the
// token, so the probe can prove the prompt-to-stdout-to-debug-rail wire.

let host = { output: () => {}, status: () => {} };
const KIND = 'debug-output';

const extractToken = (prompt) => {
    const m = String(prompt || '').match(/REPLACE_WITH:\s*(\S+)/);
    return m ? m[1] : '';
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DebugOutputAgent = () => {
    const currentDebug = {
        kind: KIND,
        label: 'debug output (stub)',
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
        label: 'debug output (stub)',
        command: null,
        configureHost: (next) => {
            host = {
                output: typeof next?.output === 'function' ? next.output : host.output,
                status: typeof next?.status === 'function' ? next.status : host.status
            };
        },
        isInstalled: () => true,
        initialize: ({ workingDirectory } = {}) =>
            setStatus({ status: 'waiting', cwd: workingDirectory || null }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: (prompt) => prompt,
        runtimePaths: () => [],
        materializeRuntime: () => {},
        run: async (prompt, context = {}) => {
            const workingDirectory = context.workingDirectory || context.canvasPath;
            if (!workingDirectory) {
                throw new Error(KIND + ': run requires workingDirectory');
            }
            const token = extractToken(prompt);
            if (!token) {
                throw new Error(KIND + ': prompt missing "REPLACE_WITH: <value>"');
            }
            setStatus({ status: 'running', cwd: workingDirectory });

            // Print a few plain stdout lines, one carrying the token. The
            // server splits output on newlines per chunk (no cross-chunk line
            // buffering), so keep the marker whole in a single output call.
            const marker = 'DEBUG_LINE: ' + token;
            try {
                host.output(KIND, 'Working on the request...\n');
                await sleep(15);
                host.output(KIND, marker + '\n');
                await sleep(15);
                host.output(KIND, 'Done!\n');
                await sleep(15);
                setStatus({ status: 'waiting' });
                return 'ok';
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                throw error;
            }
        }
    };
};

module.exports = { DebugOutputAgent };
