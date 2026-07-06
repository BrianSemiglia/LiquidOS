// Test agent for the region-streaming probe.
//
// Same wire shape as lqpatch-stream-stub-agent, but it streams into a canvas
// REGION (two distinct targets inside one region file) and into a component, to
// prove: (a) streaming into a region persists to the region's own file, (b) two
// targets in one file both update, (c) a component-scoped op still lands in
// component.html. Reads "REPLACE_WITH: <token>" from the prompt.

let host = { output: () => {}, status: () => {} };
const KIND = 'lqpatch-stream-region-stub';

const extractToken = (prompt) => {
    const m = String(prompt || '').match(/REPLACE_WITH:\s*(\S+)/);
    return m ? m[1] : '';
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const LqpatchStreamRegionStubAgent = () => {
    const currentDebug = {
        kind: KIND,
        label: 'lqpatch region stream (stub)',
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
        label: 'lqpatch region stream (stub)',
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

            // Two targets in ONE region file (regions/hero.html) + one target in a
            // component. #hero-a via atomic replace, #hero-b via streaming, and the
            // component's #target-status via replace — exercising the region stream
            // surface (both targets) and the component surface in one turn.
            const script =
                'Update the hero region.\n\n' +
                '<lqpatch target="#hero-a" op="replace">' +
                '<span>REGIONA_' + token + '</span>' +
                '</lqpatch>' +
                '\n\nStream into the second region target:\n\n' +
                '<lqpatch target="#hero-b" op="stream">' +
                'REGIONB_' + token +
                '</lqpatch>' +
                '\n\nAnd rewrite the component status:\n\n' +
                '<lqpatch target="#target-status" op="replace">' +
                '<span>PERSISTED_' + token + '</span>' +
                '</lqpatch>' +
                '\n\nDone!';

            const CHUNK = 16;
            try {
                for (let i = 0; i < script.length; i += CHUNK) {
                    host.output(KIND, script.slice(i, i + CHUNK));
                    await sleep(15);
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

module.exports = { LqpatchStreamRegionStubAgent };
