// Test agent for the service-restart probe.
//
// The probe wants to drive the harness through one full service-reload
// cycle: a <liquidos-file path="…service.sh" run> in a component, a file
// write to that script, the harness's scheduleRestart() kicking in, and
// the post-restart UI state. This stub emits an op="writeFile" patch
// against the script so the wire goes through the real path (host.output
// → sniffer → PUT /workspace → server-side watcher → SSE → liquidos-file
// restart) instead of being short-circuited.

let host = { output: () => {}, status: () => {} };
const KIND = 'service-rewrite-stub';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ServiceRewriteStubAgent = () => {
    const currentDebug = {
        kind: KIND,
        label: 'service rewrite (stub)',
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
        label: 'service rewrite (stub)',
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
            setStatus({ status: 'running', cwd: workingDirectory });

            // Same shape the real script started in (long sleep), with a
            // marker comment carrying a per-dispatch token so the probe can
            // observe the write landed.
            const token = String(prompt || '').match(/REWRITE_TAG:\s*(\S+)/)?.[1] || 'UNTAGGED';
            const scriptPath = 'home/components/target/service.js';
            const scriptBody =
                '#!/usr/bin/env node\n' +
                '// REWRITE_TAG=' + token + '\n' +
                'setInterval(() => {}, 1 << 30);\n';

            const out =
                "Rewriting the service to force a restart.\n\n" +
                '<lqpatch target="' + scriptPath + '" op="writeFile">' +
                scriptBody +
                '</lqpatch>' +
                "\n\nDone.";

            try {
                // Chunk so the sniffer sees a real stream (consistent with
                // how lqpatch-stream-stub chunks its output).
                const CHUNK = 16;
                for (let i = 0; i < out.length; i += CHUNK) {
                    host.output(KIND, out.slice(i, i + CHUNK));
                    await sleep(10);
                }
                setStatus({ status: 'waiting' });
                return 'ok';
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                throw error;
            }
        }
    };
};

module.exports = { ServiceRewriteStubAgent };
