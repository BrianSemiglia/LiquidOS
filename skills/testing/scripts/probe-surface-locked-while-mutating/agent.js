// Test agent for probe-surface-locked-while-mutating.
//
// It mutates the component by holding a single op="stream" open against a region
// inside it for a few seconds — the deterministic stand-in for an agent taking
// its time writing a card. It emits the open tag, dribbles text with pauses so
// the stream stays open across slices, then emits the close tag and resolves.
// While that stream is open the harness must have the component's surface
// disabled; the moment it closes, the surface frees.

const KIND = 'surface-mutate-test';
const CHUNKS = 25;
const GAP_MS = 200; // ~5s of open stream

let host = { output: () => {}, status: () => {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SurfaceMutateTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Surface mutate (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Surface mutate (test)', command: null,
        configureHost: (next) => { host = { output: typeof next?.output === 'function' ? next.output : host.output, status: typeof next?.status === 'function' ? next.status : host.status }; },
        isInstalled: () => true,
        initialize: ({ workingDirectory } = {}) => setStatus({ status: 'waiting', cwd: workingDirectory || null }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: (prompt) => prompt,
        runtimePaths: () => [],
        materializeRuntime: () => {},
        run: async (prompt, context = {}) => {
            setStatus({ status: 'running', cwd: context.workingDirectory || context.canvasPath || null });
            // Open a stream into a region inside the component and hold it open.
            host.output(KIND, '<lqpatch target="#stream-target" op="stream">', 'stdout');
            for (let i = 0; i < CHUNKS; i++) {
                await sleep(GAP_MS);
                host.output(KIND, 'x', 'stdout');
            }
            host.output(KIND, ' done</lqpatch>', 'stdout');
            setStatus({ status: 'waiting' });
            return 'ok';
        }
    };
};

module.exports = { SurfaceMutateTestAgent };
