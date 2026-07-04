'use strict';

// Agent sidecar — the Node half of the Go server's agent bridge.
//
// The Go core can't `require()` a JS agent, and the agent scripts must stay JS
// (the probe suite hands the server JS agents, and real agents just shell out to
// external CLIs). So the entire agent layer — createRuntimes + createActiveRuntime
// and the loaded agent scripts — runs here, unchanged, exactly as server.js hosts
// it. The Go server spawns this process and drives the runtime facade over a
// line-delimited JSON protocol on stdio.
//
// Protocol (one JSON object per line):
//   Go -> sidecar   {"id":N,"method":"probe|select|preparePrompt|currentDebug|
//                     activeKind|initialize|run","args":{...}}
//   sidecar -> Go   {"id":N,"ok":true,"result":...} | {"id":N,"ok":false,"error":"..."}
//   sidecar -> Go   {"event":"host","host":{"type":"output","label":..,"chunk":..,"stream":..}}
//                   {"event":"host","host":{"type":"status","debug":{...}}}
//                   {"event":"ready","selection":<label>}   (once, after boot)
//
// `run` is async and long-lived; replies are id-matched, so probe/select/etc.
// can be answered while a run is in flight. Agent output does NOT flow through
// the run reply — it streams as host `output` events (and the agent also talks
// to the server over HTTP via context.origin), mirroring server.js.

const readline = require('readline');
const path = require('path');
const { createRuntimes } = require('./runtimes');
const { createActiveRuntime } = require('./active-runtime');

// Keep stdout pure for the protocol: any stray console.* from an agent or a
// library must not corrupt the JSONL stream, so route it to stderr (the Go
// server inherits stderr into its own log, as server.js tees console output).
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
console.info = console.log;
console.warn = console.log;

const parseArgs = argv => {
    const out = { agents: [] };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === '--agent') out.agents.push(argv[++i]);
        else if (v === '--workspace') out.workspace = argv[++i];
        else if (v === '--app') out.app = argv[++i];
        else if (v === '--selection') out.selection = argv[++i];
    }
    return out;
};

const { agents, workspace, app, selection } = parseArgs(process.argv.slice(2));
if (!agents.length || !workspace || !app) {
    process.stderr.write('sidecar: --workspace, --app and at least one --agent are required\n');
    process.exit(1);
}

const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');

// Host wiring mirrors server.js runtimeSet.configureHosts: the agent's output
// and status callbacks are forwarded to Go as host events. In Go these drive
// the SSE broadcast (output) and the current-agent debug snapshot (status).
const bootstrap = () => {
    const runtimeSet = createRuntimes({
        agentScripts: agents.map(p => path.resolve(p)),
        runtimePath: workspace,          // server.js: AGENT_RUNTIME_PATH = WORKSPACE_PATH
        skillsPath: path.join(app, 'skills')
    });

    const activeRuntime = createActiveRuntime({
        runtimes: runtimeSet.runtimes,
        selection: selection || null
    });

    runtimeSet.configureHosts({
        output: (label, chunk, stream) =>
            emit({ event: 'host', host: { type: 'output', label, chunk: String(chunk), stream: stream || null } }),
        status: debug =>
            emit({ event: 'host', host: { type: 'status', debug } })
    });

    runtimeSet.refreshRuntime();

    return { activeRuntime, runtimePromptPath: runtimeSet.runtimePromptPath };
};

let facade;
try {
    facade = bootstrap();
} catch (error) {
    process.stderr.write('sidecar: agent bootstrap failed: ' + (error && error.stack || error) + '\n');
    process.exit(1);
}
const { activeRuntime, runtimePromptPath } = facade;

// The Go side needs runtimePromptPath for the run context's systemPromptPath
// (server.js AGENTS_RUNTIME_PATH). Report the resolved selection too.
emit({ event: 'ready', selection: activeRuntime.activeKind(), runtimePromptPath });

const handlers = {
    probe: () => activeRuntime.probe(),
    currentDebug: () => activeRuntime.currentDebug(),
    activeKind: () => activeRuntime.activeKind(),
    select: args => activeRuntime.select(args && args.kind),
    preparePrompt: args => activeRuntime.preparePrompt(args && args.prompt, (args && args.options) || {}),
    initialize: args => activeRuntime.initialize((args && args.options) || {}),
    run: args => activeRuntime.run(args && args.prompt, (args && args.context) || {})
};

const dispatch = async message => {
    const { id, method, args } = message;
    const handler = handlers[method];
    if (!handler) {
        emit({ id, ok: false, error: 'unknown method: ' + method });
        return;
    }
    try {
        const result = await handler(args);
        emit({ id, ok: true, result: result === undefined ? null : result });
    } catch (error) {
        emit({ id, ok: false, error: (error && error.message) || String(error) });
    }
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
        message = JSON.parse(trimmed);
    } catch {
        process.stderr.write('sidecar: bad protocol line: ' + trimmed.slice(0, 200) + '\n');
        return;
    }
    dispatch(message);
});
rl.on('close', () => process.exit(0));
