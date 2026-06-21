const http = require('http');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const parcelWatcher = require('@parcel/watcher');
const { createActivityPersistence } = require('./canvas/activity-persistence');
const { createRuntimes } = require('./agent/(workspacePath+runtimePath+skillsPath)->runtimes');
const { createActiveRuntime } = require('./agent/(runtimes+selection)->active-runtime');
const { createCanvasFiles } = require('./canvas/files');
const { createCanvasGraph } = require('./canvas/graph');
const { createOutputQueue } = require('./canvas/output-queue');
const crashRecovery = require('./canvas/crash-recovery');
const { createPromptBuilder } = require('./canvas/prompt-builder');
const { bootstrapWorkspace } = require('./workspace/bootstrap');

const ROOT = __dirname;
const SERVER_BUILD = 'hermes-output-server-2026-05-10-canvases-git-timeline';

// Inspection tools the agent (and the user) can run from inside the
// workspace. Prepend the directory to PATH so `processes`, etc. resolve
// without absolute paths; export the harness PID so those tools can root
// their process-tree walks without scanning.
process.env.PATH = path.join(ROOT, 'diagnostics') + ':' + (process.env.PATH || '');
process.env.LIQUIDOS_HARNESS_PID = String(process.pid);

const VALID_AGENT_KINDS = new Set(['codex', 'claude-code', 'hermes', 'pi', 'none',
    'callback-dispatch-test', 'canvas-build-test', 'component-repair-test', 'component-build-test', 'canvas-repair-test',
    'canvas-damaged-repair-test', 'component-runtime-repair-test', 'prompt-bar-single-dispatch-test',
    'prompt-bar-test', 'install-build-test', 'cross-canvas-persistence-test', 'lqpatch-stream-stub',
    'service-rewrite-stub', 'crash-repair-stub', 'chat-stub', 'stub-a', 'stub-b']);

const failStartup = message => {
    console.error(message);
    process.exit(1);
};

const argumentPairs = () => {
    const values = new Map();
    const args = process.argv.slice(2);

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];

        if (!arg.startsWith('--')) {
            failStartup('Unexpected positional argument: ' + arg);
        }

        const equalsIndex = arg.indexOf('=');
        const name = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
        const value = equalsIndex === -1 ? args[index + 1] : arg.slice(equalsIndex + 1);

        if (!['--workspace', '--agent', '--port', '--agent-timeout-ms'].includes(name)) {
            failStartup('Unknown argument: ' + name);
        }

        if (!value || value.startsWith('--')) {
            failStartup('Missing value for ' + name);
        }

        values.set(name, value);

        if (equalsIndex === -1) {
            index += 1;
        }
    }

    return values;
};

const REQUIRED_ARGUMENTS = argumentPairs();

const requiredArg = name => {
    if (!REQUIRED_ARGUMENTS.has(name)) {
        failStartup('Missing required argument: ' + name);
    }

    return REQUIRED_ARGUMENTS.get(name);
};

const expandUserPath = value => {
    const stringValue = String(value || '');
    if (stringValue.startsWith('~/')) {
        return path.join(os.homedir(), stringValue.slice(2));
    }

    if (stringValue === '~') {
        return os.homedir();
    }

    return stringValue;
};

const resolveConfigPath = value =>
    path.isAbsolute(expandUserPath(value))
        ? expandUserPath(value)
        : path.resolve(ROOT, expandUserPath(value));

const resolveCanvasReference = value => {
    if (!value) {
        return value;
    }

    if (path.isAbsolute(value)) {
        return value;
    }

    return path.resolve(CANVAS_PATH, value);
};

const absoluteScope = scope => {
    const value = String(scope || '').trim();

    if (!value || value === '.' || value === './') {
        return CANVAS_PATH;
    }

    if (path.isAbsolute(value)) {
        return path.normalize(value);
    }

    const relative = value.replace(/^\.\//, '');
    const canvasName = path.basename(CANVAS_PATH);

    if (relative === canvasName || relative.startsWith(canvasName + '/')) {
        return path.resolve(WORKSPACE_PATH, relative);
    }

    return path.resolve(CANVAS_PATH, relative);
};

// Each queued job carries its own absolute scope. The job's canvas is
// derived from that scope — the first path segment under WORKSPACE_PATH.
// This makes jobs self-contained: a pending job for canvas A still runs
// against canvas A's folder even after the user has switched to canvas B,
// so the queue doesn't need to be reset on canvas change.
const canvasPathFromScope = scope => {
    const value = String(scope || '').trim();
    if (!value) return CANVAS_PATH;
    const absolute = path.isAbsolute(value) ? path.normalize(value) : path.resolve(WORKSPACE_PATH, value);
    const relative = path.relative(WORKSPACE_PATH, absolute);
    if (!relative || relative.startsWith('..')) return CANVAS_PATH;
    return path.join(WORKSPACE_PATH, relative.split(path.sep)[0]);
};

const WORKSPACE_PATH = resolveConfigPath(requiredArg('--workspace'));
const DEFAULT_AGENT_KIND = String(requiredArg('--agent')).trim().toLowerCase();

if (!VALID_AGENT_KINDS.has(DEFAULT_AGENT_KIND)) {
    failStartup('Invalid --agent. Expected one of: codex, claude-code, hermes, pi');
}

if (path.extname(WORKSPACE_PATH) !== '.liquidos') {
    failStartup('--workspace must be a .liquidos folder');
}

if (!fs.existsSync(WORKSPACE_PATH) || !fs.statSync(WORKSPACE_PATH).isDirectory()) {
    failStartup('--workspace does not exist or is not a folder: ' + WORKSPACE_PATH);
}

// Server log capture: tee every stdout/stderr line to
// <workspace>/.liquidos/server.log so an agent debugging server-level
// issues (hangs, agent dispatch loops, file watcher anomalies) has a
// durable record. Always on — the Mac app pipes console output back into
// itself and drops everything that isn't a native notification, so this
// file is the only thing that survives a hung process. The file appends
// across restarts; each session writes a startup banner with pid + time.
try {
    const logDir = path.join(WORKSPACE_PATH, '.liquidos');
    fs.mkdirSync(logDir, { recursive: true });
    const logStream = fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'a' });
    logStream.write(`\n=== server.js started pid=${process.pid} at ${new Date().toISOString()} workspace=${WORKSPACE_PATH} ===\n`);
    const tee = (origMethod, level) => (...args) => {
        try {
            const line = args
                .map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())
                .join(' ');
            logStream.write(`[${new Date().toISOString()}] [${level}] ${line}\n`);
        } catch { /* never let logging break the server */ }
        origMethod.apply(console, args);
    };
    console.log = tee(console.log, 'log');
    console.error = tee(console.error, 'err');
    console.warn = tee(console.warn, 'warn');
    process.on('uncaughtException', error => {
        try { logStream.write(`[${new Date().toISOString()}] [uncaught] ${error.stack || error.message || error}\n`); } catch {}
    });
    process.on('unhandledRejection', reason => {
        try { logStream.write(`[${new Date().toISOString()}] [unhandled] ${reason && reason.stack ? reason.stack : String(reason)}\n`); } catch {}
    });
} catch { /* mkdir / createWriteStream failed — fall back to no file capture */ }

const CANVAS_TEMPLATE_ROOT = path.join(ROOT, 'skills', 'canvas', 'scripts', 'templates');
const DEFAULT_CANVAS_NAME = 'home';
const DEFAULT_CANVAS_PATH = path.join(WORKSPACE_PATH, DEFAULT_CANVAS_NAME);

const validCanvasName = value =>
    typeof value === 'string'
        && value.trim() === value
        && /^[^/][^/]*$/.test(value)
        && !value.startsWith('.')
        && !value.includes('..');

const validAgentKind = value =>
    typeof value === 'string'
        && VALID_AGENT_KINDS.has(value.trim().toLowerCase());

// ui-state.json is the single workspace-state file: it names the active canvas
// and the active agent, AND persists which "system" panels are open — escape
// mode (the prompt bar hidden for a clean canvas), the Spaces canvas picker, the
// canvas requirements editor, and a component's requirements editor. It's a
// plain workspace file the harness watches; there's no dedicated endpoint and no
// server-side state to keep in sync. The client writes it through the generic
// PUT /workspace/ path (switching canvas/agent, opening/closing panels), an
// agent can write it to drive the surface for the user, and either way the
// watcher applies any canvas/agent switch and broadcasts the new state to every
// client. Every writer does a full-shape write (or read-merge), so no writer
// ever drops a key. Absent file = home canvas, default agent, everything closed.
const UI_STATE_FILE = path.join(WORKSPACE_PATH, 'ui-state.json');

const uiStateFromFile = () => {
    try {
        if (!fs.existsSync(UI_STATE_FILE)) return {};
        const parsed = JSON.parse(fs.readFileSync(UI_STATE_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

// The active canvas lives in ui-state.json's `canvas` key. Returns null when the
// file is absent or the key is missing/invalid so callers can distinguish "no
// opinion" (keep the current canvas; cold start falls back to home) from a real,
// validated switch request.
const activeCanvasNameFromFile = () => {
    const value = uiStateFromFile().canvas;
    return validCanvasName(value) ? value : null;
};

// The active agent lives in ui-state.json's `agent` key. Returns null when the
// file is absent or the key is missing/invalid so callers can distinguish "no
// opinion" (keep the current agent; cold start falls back to the launch default)
// from a real, validated switch request.
const activeAgentKindFromFile = () => {
    const value = uiStateFromFile().agent;
    return validAgentKind(value) ? value.trim().toLowerCase() : null;
};

const canvasNameFromPath = canvasPath =>
    path.relative(WORKSPACE_PATH, canvasPath) || path.basename(canvasPath);

let CANVAS_PATH = path.join(WORKSPACE_PATH, activeCanvasNameFromFile() || DEFAULT_CANVAS_NAME);
let INDEX_PATH = path.join(CANVAS_PATH, 'index.json');
let ACTIVE_AGENT_KIND = activeAgentKindFromFile() || DEFAULT_AGENT_KIND;
// The agent runs with the workspace as its CWD. Each agent's discovery
// dir (.claude/, .codex/, .hermes/, .pi/, .agents/) and the system-prompt
// file (AGENTS.md) are materialized directly inside the workspace, so
// there is no separate runtime tree under Application Support.
const AGENT_RUNTIME_PATH = WORKSPACE_PATH;
const SKILLS_SOURCE_PATH = path.join(ROOT, 'skills');

// Bootstrap the workspace as a git repo with the runtime-managed
// .gitignore entries. Skills are no longer copied to a plain
// <workspace>/skills/ folder; each agent's runtime materializes its own
// skill tree under its discovery dir. Failures here don't abort startup
// — the runtime should still come up so the user can recover.
const WORKSPACE_BOOTSTRAP = bootstrapWorkspace({ workspacePath: WORKSPACE_PATH });
if (WORKSPACE_BOOTSTRAP.error) {
    console.warn('[workspace-bootstrap] failed:', WORKSPACE_BOOTSTRAP.error);
} else if (WORKSPACE_BOOTSTRAP.initialized) {
    console.log('[workspace-bootstrap] initialized workspace git');
}

const runtimeSet = createRuntimes({
    runtimePath: AGENT_RUNTIME_PATH,
    skillsPath: SKILLS_SOURCE_PATH
});
const activeRuntime = createActiveRuntime({
    runtimes: runtimeSet.runtimes,
    selection: ACTIVE_AGENT_KIND
});
ACTIVE_AGENT_KIND = activeRuntime.activeKind() || ACTIVE_AGENT_KIND;
const AGENTS_RUNTIME_PATH = runtimeSet.runtimePromptPath;


const pathIsInside = (file, basePath) => {
    const relative = path.relative(basePath, file);
    return relative === '' || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
};

const resolveCanvasLocalFile = file =>
    path.isAbsolute(file) ? path.normalize(file) : path.resolve(CANVAS_PATH, file);

const isCanvasLocalFile = file =>
    pathIsInside(resolveCanvasLocalFile(file), path.resolve(CANVAS_PATH));

const streamCanvasFile = (req, res, file, type) => {
    if (!isCanvasLocalFile(file)) {
        send(res, 403, 'Use a served URL for files outside the canvas folder');
        return;
    }

    streamFile(req, res, resolveCanvasLocalFile(file), type);
};

fs.mkdirSync(WORKSPACE_PATH, { recursive: true });

if (!fs.existsSync(path.join(CANVAS_PATH, 'index.json'))) {
    // ui-state.json named a canvas that no longer exists (or none at all):
    // fall back to home in memory. The client rewrites ui-state.json's canvas
    // key on its next switch; until then the stale key is ignored because
    // applyActiveCanvasFromFile only acts on a canvas that actually exists.
    CANVAS_PATH = DEFAULT_CANVAS_PATH;
    INDEX_PATH = path.join(CANVAS_PATH, 'index.json');
}

runtimeSet.refreshRuntime();
const PORT = Number.parseInt(requiredArg('--port'), 10);

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
    failStartup('--port must be an integer from 0 to 65535');
}
const AGENT_SOURCE = 'agent';
const clients = new Set();
const agentStreamClients = new Set();

// The serializer. Every producer (the agent, each service) streams on the
// same SSE channel alongside the debug-* events the rail reads. Rather
// than ship raw bytes and parse on the client, the server runs one lqpatch
// sniffer PER producer and emits framed, sequenced `slice` events:
//
//   { kind:'narration', source, text }            — text outside any marker
//   { kind:'atomic',  seq, source, attrs, inner }  — a complete non-stream op
//   { kind:'open',     seq, source, attrs }         — a streaming op begins
//   { kind:'chunk',    seq, text }                  — one streamed chunk
//   { kind:'close',    seq }                        — the streaming op ends
//   { kind:'reject',   seq, source, reason, attrs } — failed framing (bad op)
//
// One sniffer per producer means a marker one producer holds open can never
// swallow another's bytes. The monotonic `seq` gives every slice a single
// authoritative order across all producers. The client validates targets,
// enforces per-component scope, and applies — it never has to reassemble an
// interleaved byte stream. Diagnostics (a service's stderr) never enter
// here; they stay in the server log.
let serverCreateSniffer = null;
const snifferReady = import('./lib/lqpatch-sniffer.js')
    .then(m => { serverCreateSniffer = m.createSniffer; })
    .catch(e => { console.error('lqpatch-sniffer import failed', e); });

const SLICE_ALLOWED_OPS = new Set(['replace', 'append', 'prepend', 'setAttr', 'remove', 'stream', 'writeFile']);
const SLICE_STREAMING_OPS = new Set(['stream', 'replace', 'append', 'prepend']);

let sliceSeq = 0;
const emitSlice = payload => {
    const message = JSON.stringify(payload);
    agentStreamClients.forEach(res => {
        res.write('event: slice\n');
        res.write('data: ' + message + '\n\n');
    });
};

const serverSniffers = new Map();
const serverSnifferFor = (source) => {
    let sniff = serverSniffers.get(source);
    if (sniff) return sniff;
    if (!serverCreateSniffer) return null;
    // No DOM-aware validate here: the server only frames + sequences.
    // Target resolution, scope enforcement, and rejection live on the
    // client, which is the only side with a DOM.
    sniff = serverCreateSniffer({
        allowedOps: SLICE_ALLOWED_OPS,
        streamingOps: SLICE_STREAMING_OPS,
        onText: (text) => emitSlice({ kind: 'narration', source, text }),
        onAtomic: (attrs, inner) => emitSlice({ kind: 'atomic', seq: ++sliceSeq, source, attrs, inner }),
        onStreamOpen: (attrs) => {
            const seq = ++sliceSeq;
            emitSlice({ kind: 'open', seq, source, attrs });
            return {
                appendChunk: (text) => emitSlice({ kind: 'chunk', seq, text }),
                close: () => emitSlice({ kind: 'close', seq })
            };
        },
        onReject: (reason, attrs) => emitSlice({ kind: 'reject', seq: ++sliceSeq, source, reason, attrs })
    });
    serverSniffers.set(source, sniff);
    return sniff;
};

// Feed one producer's output chunk into its sniffer. Until the sniffer
// module finishes loading (a microtask at startup, long before any agent
// or service emits), fall back to shipping the chunk as narration so no
// output is ever dropped.
const serializeProducerChunk = (source, chunk) => {
    if (!chunk) return;
    const sniff = serverSnifferFor(source);
    if (sniff) sniff(String(chunk));
    else emitSlice({ kind: 'narration', source, text: String(chunk) });
};

const emitDebugEvent = payload => {
    const message = JSON.stringify(payload);
    agentStreamClients.forEach(res => {
        res.write('event: ' + payload.type + '\n');
        res.write('data: ' + message + '\n\n');
    });
};
let activeCanvasRuntime = null;
let outputQueue = null;
const agentDebugState = {
    current: {
        kind: 'idle',
        label: 'Idle',
        status: 'waiting'
    },
    lines: []
};


const stripAnsi = value =>
    String(value || '')
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
        .replace(/\r/g, '');

const pushAgentDebugLine = chunk => {
    String(chunk || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .forEach(line => {
            const text = stripAnsi(line).trimEnd();

            if (!text.trim()) {
                return;
            }

            agentDebugState.lines.push({ text });
            emitDebugEvent({ type: 'debug-line', line: agentDebugState.lines[agentDebugState.lines.length - 1] });
        });
};

const setCurrentAgentDebug = next => {
    const prevStatus = agentDebugState.current && agentDebugState.current.status;
    agentDebugState.current = {
        ...next,
        source: next.source || AGENT_SOURCE,
        at: new Date().toISOString()
    };

    // When the agent leaves "running", flush its sniffer so any trailing
    // narration buffered after the last marker is emitted (the client used
    // to do this on the same transition; the parser lives here now).
    if (prevStatus === 'running' && agentDebugState.current.status && agentDebugState.current.status !== 'running') {
        const sniff = serverSniffers.get(AGENT_SOURCE);
        if (sniff && sniff.end) sniff.end();
    }

    if (typeof emitDebugEvent === 'function') {
        emitDebugEvent({ type: 'debug-status', current: agentDebugState.current });
    }
};

const currentAgentDebugSnapshot = () => {
    const activeDebug = activeRuntime.currentDebug();
    const activeRuntimeInstance = activeRuntime.activeRuntime();

    return {
        current: agentDebugState.current,
        lines: agentDebugState.lines,
        agentKind: activeRuntime.activeKind(),
        active: activeRuntime
            ? {
                ...(activeDebug || {}),
                kind: activeRuntime.activeKind(),
                label: activeRuntimeInstance ? activeRuntimeInstance.label || null : null
            }
            : null
    };
};

const logServer = (area, message, details = null) => {
    const suffix = details ? ' ' + JSON.stringify(details) : '';
    console.log(`[${new Date().toISOString()}] [${area}] ${message}${suffix}`);
};

const logHermesError = (area, error, details = null) => {
    const message = error instanceof Error ? error.message : String(error || 'Unknown error');
    const suffix = details ? ' ' + JSON.stringify(details) : '';
    console.error(`[${new Date().toISOString()}] [${area}] ${message}${suffix}`);

    if (error && error.stack) {
        console.error(error.stack);
    }
};

const writeProcessOutput = (label, chunk, stream = process.stdout) => {
    String(chunk || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split(/(?<=\n)/)
        .forEach(line => {
            if (!line.length) {
                return;
            }

            const cleanLine = stripAnsi(line);

            if (!cleanLine.trim()) {
                return;
            }

            stream.write(`${label} ${line}`);
            pushAgentDebugLine(line);
        });
};

const shortText = value => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > 160 ? text.slice(0, 157) + '...' : text;
};


runtimeSet.configureHosts({
    output: (label, chunk, stream) => {
        serializeProducerChunk(AGENT_SOURCE, chunk);
        writeProcessOutput(label, chunk, stream);
    },
    status: setCurrentAgentDebug
});

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const canvasFiles = createCanvasFiles({
    fs,
    workspacePath: WORKSPACE_PATH,
    canvasTemplateRoot: CANVAS_TEMPLATE_ROOT,
    localAssetRoot: path.join(ROOT, 'skills', 'canvas'),
    getCanvasPath: () => CANVAS_PATH,
    setCanvasPath: canvasPath => setCanvasPath(canvasPath),
    readJson
});

const canvasGraph = createCanvasGraph({
    fs,
    getCanvasPath: () => CANVAS_PATH,
    getIndexPath: () => INDEX_PATH,
    readJson,
    resolveCanvasReference
});

canvasFiles.ensureCanvasDefaults('home');

const ensureActiveCanvasFiles = () => {
    if (!fs.existsSync(INDEX_PATH)) {
        throw new Error('Canvas index.json not found: ' + INDEX_PATH);
    }
};

const applyCanvasRuntime = runtime => {
    CANVAS_PATH = runtime.canvasPath;
    INDEX_PATH = runtime.indexPath;
    return runtime;
};

const createCanvasRuntime = canvasPath => {
    const resolvedCanvasPath = resolveConfigPath(canvasPath);

    return {
        canvasPath: resolvedCanvasPath,
        indexPath: path.join(resolvedCanvasPath, 'index.json'),
        started: false,

        start() {
            applyCanvasRuntime(this);
            runtimeSet.refreshRuntime();
            this.started = true;
            ensureActiveCanvasFiles();
            activityPersistence.ensureActivityPersistenceRepo();
            outputQueue.feedHermesOutput();
            broadcastQueueState();
            return this;
        },

        stop() {
            if (activeCanvasRuntime !== this) {
                return this;
            }

            // The workspace watcher is workspace-scoped, not canvas-scoped:
            // it spans every canvas and outlives a switch, so stop() leaves it
            // running. Only the active-canvas pointer changes.
            outputQueue.clearActiveLanes();
            this.started = false;
            return this;
        }
    };
};

// Apply a canvas as active in memory (swap the runtime). The active-canvas
// pointer is not written here: ui-state.json is owned by its writers (the
// client and agents), and a switch always originates from one of them writing
// that file — so the file is already correct by the time this runs.
const setCanvasPath = canvasPath => {
    const nextCanvasPath = resolveConfigPath(canvasPath);

    if (activeCanvasRuntime && activeCanvasRuntime.canvasPath === nextCanvasPath) {
        activeCanvasRuntime.start();
        return activeCanvasRuntime;
    }

    if (activeCanvasRuntime) {
        activeCanvasRuntime.stop();
    }

    activeCanvasRuntime = createCanvasRuntime(nextCanvasPath);
    activeCanvasRuntime.start();
    return activeCanvasRuntime;
};

const callbackPromptText = job => job.prompt || '';

const isCanvasScope = scope => {
    if (!scope) {
        return false;
    }

    try {
        return absoluteScope(scope) === CANVAS_PATH;
    } catch (error) {
        return false;
    }
};

outputQueue = createOutputQueue({
    workspacePath: ROOT,
    getCanvasPath: () => CANVAS_PATH,
    logServer,
    logHermesError,
    callbackPromptText,
    shortText,
    resolveCanvasReference,
    isCanvasScope
});


const activityPersistence = createActivityPersistence({
    workspacePath: WORKSPACE_PATH,
    currentCanvasPath: () => CANVAS_PATH,
    logServer
});

const promptBuilder = createPromptBuilder({
    getCanvasPath: () => CANVAS_PATH,
    callbackPromptText
});


const emitNativeNotification = ({ title, body }) => {
    if (process.env.LIQUIDOS_RUNTIME_KIND !== 'mac-app') return;

    process.stdout.write('LIQUIDOS_NATIVE_NOTIFICATION ' + JSON.stringify({
        title: String(title || 'LiquidOS'),
        body: String(body || '')
    }) + '\n');
};

// Tell the app whether the workspace is mid crash-recovery. The app shows a
// recovery screen (streaming the agent's repair activity from /agent/stream)
// while we're 'recovering', and loads the canvas once we're 'ready'. Same
// stdout-line channel as native notifications, only meaningful under the app.
const emitRecoveryState = state => {
    if (process.env.LIQUIDOS_RUNTIME_KIND !== 'mac-app') return;
    process.stdout.write('LIQUIDOS_RECOVERY ' + JSON.stringify({ state: String(state) }) + '\n');
};

// The crash-recovery screen (served at GET /recovery). Shows a single, evolving,
// human-friendly status of what the agent is doing — not the raw tool transcript.
// During recovery the agent rarely curates the #agent-activity badge, so we derive
// the status from the tool steps it DOES reliably emit (the "> Tool arg" debug
// lines): "Reading server.js…", "Running a command…", etc. If the agent does post
// to #agent-activity, that wins (it's its own words). Tool RESULTS ("< …", the
// bulky dumps the user didn't want) are ignored.
const RECOVERY_PAGE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: dark; }
    html, body { width: 100%; height: 100%; margin: 0; background: #121212; }
    body {
      display: flex; flex-direction: column; box-sizing: border-box;
      height: 100%; padding: 0 48px; gap: 14px;
      align-items: flex-start; justify-content: center;
      color: rgba(255,255,255,0.88);
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      font-size: 14px;
      -webkit-font-smoothing: antialiased;
    }
    h1 { font-size: 17px; font-weight: 600; margin: 0; }
    .sub { color: rgba(255,255,255,0.55); font-size: 13px; margin: 0; max-width: 46ch; }
    #status { margin-top: 6px; font-size: 14px; line-height: 1.5; color: rgba(255,255,255,0.92); min-height: 1.5em; }
  </style>
</head>
<body>
  <h1>Recovering from a crash…</h1>
  <p class="sub">Something took the workspace down. The agent is repairing it — your workspace will return when it's safe to load.</p>
  <div id="status" role="status" aria-live="polite">Starting…</div>
  <script>
    const el = document.getElementById('status');
    const setStatus = (t) => { if (t && t.trim()) el.textContent = t.trim(); };

    // A "> Tool arg" debug line → a plain-language phase, no file names or
    // commands. Returns null for non-tool lines (results, reasoning) so the
    // status holds steady between steps.
    const friendly = (text) => {
      const m = String(text).match(/^> (\\w+)/);
      if (!m) return null;
      switch (m[1]) {
        case 'Read': case 'Grep': case 'Glob': return 'Looking into the problem…';
        case 'Edit': case 'Write': case 'NotebookEdit': return 'Making a change…';
        case 'WebFetch': case 'WebSearch': return 'Looking something up…';
        case 'Bash': case 'Skill': case 'Task': case 'Agent': return 'Working on the fix…';
        default: return null;
      }
    };

    const es = new EventSource('/agent/stream');

    // The agent's own curated status, when it bothers to set one — that wins.
    const streams = new Map();
    es.addEventListener('slice', (e) => {
      let p; try { p = JSON.parse(e.data); } catch { return; }
      const a = p.attrs || {};
      if (a.target !== '#agent-activity') return;
      if (p.kind === 'atomic') { if (a.op === 'replace') setStatus(stripTags(p.inner)); return; }
      if (p.kind === 'open' && a.op === 'replace') { streams.set(p.seq, ''); return; }
      if (p.kind === 'chunk' && streams.has(p.seq)) { streams.set(p.seq, streams.get(p.seq) + (p.text || '')); setStatus(stripTags(streams.get(p.seq))); return; }
      if (p.kind === 'close') { streams.delete(p.seq); return; }
    });
    const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '');

    // Otherwise, derive the status from the tool steps the agent reliably emits.
    es.addEventListener('debug-line', (e) => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      const f = friendly(d.line && d.line.text);
      if (f) setStatus(f);
    });

    es.onerror = () => {}; // EventSource auto-retries
  </script>
</body>
</html>`;

const buildAgentPrompt = job => {
    const prompt = promptBuilder.buildJobPrompt(job);

    return activeRuntime.preparePrompt(prompt);
};

const runQueuedAgentJob = (prompt, context = {}) => {
    return activeRuntime.run(prompt, context);
};

let activeOutputJob = null;
let shutdownCommitAttempted = false;
// True while Phase 1 of a crash recovery is making the workspace bootable. The
// client auto-starts run-mode services (on mount and on every workspace-file
// change), so without this the offender would be re-spawned — and re-crash the
// server — the moment the agent touches a file. We hold ALL service spawns until
// Phase 1 commits, since the harness names no culprit. See dispatchCrashRecovery.
let recovering = false;
// Phase 1 waits in here until the recovery screen connects to /agent/stream, so
// the screen sees the agent's activity live (no replay needed). Fired by the
// /agent/stream handler, or by a fallback timer if no screen ever connects.
let pendingCrashDispatch = null;
const firePendingCrashDispatch = () => {
    const fire = pendingCrashDispatch;
    pendingCrashDispatch = null;
    if (fire) fire();
};

const processOutputJob = async job => {
    const jobId = job.id || 'job-' + Date.now();
    // Derive everything from the job's own scope so the job runs against
    // its target canvas regardless of which canvas the user is currently
    // viewing. This is what makes the queue safe to keep across canvas
    // switches.
    const jobCanvasPath = canvasPathFromScope(job.scope);
    const componentPath = job.componentPath
        ? (path.isAbsolute(job.componentPath) ? path.normalize(job.componentPath) : path.resolve(jobCanvasPath, job.componentPath))
        : null;
    const laneKey = outputQueue.outputJobKey(job);
    const startedAt = Date.now();
    activeOutputJob = { ...job, id: jobId, componentPath };

    logServer('queue', 'job claimed', {
        canvas: jobCanvasPath,
        job: outputQueue.outputJobSummary({ ...job, id: jobId, componentPath }),
        lane: laneKey
    });

    await outputQueue.updateOutputJob(jobId, {
        ...job,
        id: jobId,
        componentKey: laneKey,
        status: 'running',
        startedAt: new Date().toISOString()
    });
    broadcastQueueState();

    logServer('queue', 'job marked running', {
        job: outputQueue.outputJobSummary({ ...job, id: jobId, componentPath, status: 'running' })
    });

    let agentResponse = '';

    try {
        agentResponse = await runQueuedAgentJob(buildAgentPrompt({ ...job, id: jobId, componentPath }), {
            job: outputQueue.outputJobSummary({ ...job, id: jobId, componentPath, status: 'running' }),
            canvasPath: jobCanvasPath,
            indexPath: path.join(jobCanvasPath, 'index.json'),
            workingDirectory: WORKSPACE_PATH,
            systemPromptPath: AGENTS_RUNTIME_PATH
        });

        const activityRecord = activityPersistence.persistActivity({
            event: job.event || null,
            scope: job.scope || null,
            prompt: job.prompt || '',
            agentResponse,
            mode: 'done'
        });

        activeOutputJob = {
            ...activeOutputJob,
            activityRecord
        };

        if (/Blocked:|error=patch rejected|not writable in this environment|writing outside of the project/i.test(agentResponse)) {
            throw new Error('Agent failed the live canvas write check and the test was stopped early.');
        }

        logServer('agent', 'agent job returned', {
            jobId,
            response: shortText(agentResponse)
        });

        canvasGraph.validateCanvasConfig();

        await outputQueue.updateOutputJob(jobId, {
            status: 'done',
            completedAt: new Date().toISOString()
        });
        broadcastQueueState('', { lane: laneKey, status: 'done' });

        logServer('queue', 'job marked done', {
            jobId,
            lane: laneKey,
            durationMs: Date.now() - startedAt
        });

        emitNativeNotification({
            title: 'Finished',
            body: job.prompt
        });
    } catch (error) {
        const activityRecord = activityPersistence.persistActivity({
            event: job.event || null,
            scope: job.scope || null,
            prompt: job.prompt || '',
            agentResponse,
            mode: 'failed',
            error: error.message
        });

        activeOutputJob = {
            ...activeOutputJob,
            activityRecord
        };

        canvasGraph.validateCanvasConfig();
        await outputQueue.updateOutputJob(jobId, {
            status: 'failed',
            failedAt: new Date().toISOString(),
            error: error.message
        });
        broadcastQueueState('', { lane: laneKey, status: 'failed' });
        logServer('queue', 'job marked failed', {
            jobId,
            lane: laneKey,
            durationMs: Date.now() - startedAt,
            error: error.message
        });

        emitNativeNotification({
            title: 'Failed',
            body: job.prompt
        });

    } finally {
        if (activeOutputJob && activeOutputJob.id === jobId) {
            activeOutputJob = null;
        }
    }
};

// Run every queued job through processOutputJob, and chain crash recovery:
// once a Phase 1 (make-bootable) job commits, the workspace is bootable, so
// continue to Phase 2 (the permanent fix) without waiting for another boot.
outputQueue.setProcessJob(async job => {
    try {
        await processOutputJob(job);
    } finally {
        if (job && job.event === crashRecovery.RECOVER_EVENT) {
            // The workspace is bootable again — let services spawn (the
            // re-render that follows starts the survivors), tell the app to
            // leave the recovery screen for the canvas, and continue to the
            // permanent fix.
            recovering = false;
            emitRecoveryState('ready');
            dispatchPermanentFixIfOwed();
        }
    }
});

const canvasName = canvasNameFromPath;

const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, {
        'Cache-Control': 'no-cache',
        'Content-Type': type
    });
    res.end(body);
};

const broadcast = payload => {
    const message = payload ? JSON.stringify(payload) : 'update';
    clients.forEach(res => res.write('data: ' + message + '\n\n'));
};

const queueStatePayload = (componentPath, completed) => ({
    type: 'queue-status',
    state: outputQueue.currentBusyState(componentPath),
    completed: completed || null
});

const broadcastQueueState = (componentPath = '', completed = null) => {
    broadcast(queueStatePayload(componentPath, completed));
};

// Structural files (canvas.js, index.json, relationships/) have no element
// on the page watching them — they re-render through the graph. Coalesce a
// burst of them (an install copying many files, an agent's multi-file edit)
// into one re-read + one generic update so the client runs load() once, not
// once per file.
let graphRefreshTimer = null;
const scheduleGraphRefresh = () => {
    if (graphRefreshTimer) return;
    graphRefreshTimer = setTimeout(() => {
        graphRefreshTimer = null;
        try {
            canvasGraph.renderedInput();
        } catch (error) {
            logHermesError('watch', error, { message: 'graph refresh failed' });
        }
        broadcast();
    }, 30);
};

// Canvas folders are non-dotted direct children of the workspace
// (see canvas/files.js availableCanvases). The workspace watcher fires
// canvases-changed only for entries that could plausibly be a canvas
// — never for dotfiles like .git, .claude/, .codex/, AGENTS.md, etc.,
// which are runtime/system files outside the canvas namespace.
const isCanvasCandidateFilename = filename =>
    typeof filename === 'string'
        && filename.length > 0
        && !filename.startsWith('.')
        && !filename.includes('/');

// ui-state.json's `canvas` key is the source of truth for the active canvas:
// the client, an agent, or an external editor may write it. The workspace
// watcher detects the change, diffs the desired canvas against in-memory state,
// and applies. A missing/invalid key (null) means "no opinion" — leave the
// current canvas alone, so a panel-only write never moves the canvas.
const applyActiveCanvasFromFile = () => {
    const name = activeCanvasNameFromFile();
    if (!name) return;
    const desiredPath = path.join(WORKSPACE_PATH, name);
    if (CANVAS_PATH === desiredPath) return;
    try {
        canvasFiles.switchCanvas(name);
    } catch (error) {
        logHermesError('active-canvas', error, {
            message: 'ui-state.json names a missing or invalid canvas: ' + name
        });
        return;
    }
    broadcast({ type: 'canvases-changed' });
    broadcast();
};

// ui-state.json's `agent` key is the source of truth for the active agent kind:
// the client, an agent, or an external editor may write it. The watcher detects
// the change, validates the kind through the runtime, and applies it. A
// missing/invalid key (null) or one that already matches is a no-op, so a
// canvas/panel-only write never disturbs the agent. select() rejects unknown or
// uninstalled kinds — log and leave the agent where it was, same as a bad canvas.
const applyActiveAgentFromFile = () => {
    const kind = activeAgentKindFromFile();
    if (!kind || kind === ACTIVE_AGENT_KIND) return;
    const result = activeRuntime.select(kind);
    if (!result.ok) {
        logHermesError('active-agent', new Error(result.error || 'agent select failed'), {
            message: 'ui-state.json names an unavailable agent: ' + kind
        });
        return;
    }
    ACTIVE_AGENT_KIND = activeRuntime.activeKind() || kind;
    if (outputQueue) {
        outputQueue.feedHermesOutput();
    }
    broadcast({ type: 'agent-mode', agentKind: ACTIVE_AGENT_KIND });
};

// One @parcel/watcher subscription on the whole workspace replaces the
// fs.watch instances this used to juggle. @parcel/watcher drives the native
// FSEvents/inotify backends directly and reliably reports every change —
// including the server's own writes (the lqpatch writeFile PUT, /writes,
// /canvas) — so no endpoint needs to announce its own writes; the watcher is
// the single source of "a file changed → tell the clients". It's
// workspace-scoped (WORKSPACE_PATH never changes for the life of the server),
// so the subscription is established once and never torn down on a canvas
// switch — the close/reopen cycle that used to race FSEvents and drop events
// is gone.
//
// @parcel/watcher resolves symlinks, so event paths arrive under the real
// path (/var → /private/var on macOS). Diff against the resolved root so
// workspace-relative paths line up with what the client watches.
let workspaceSubscription = null;
const workspaceWatchRoot = (() => {
    try { return fs.realpathSync(WORKSPACE_PATH); } catch { return WORKSPACE_PATH; }
})();

// Returns true when the change is to a structural file (the graph owns it and
// must re-render); false when it's already handled (a component morph, an
// active-canvas switch, a canvas-list change) or irrelevant.
const dispatchWorkspaceEvent = absPath => {
    const rel = path.relative(workspaceWatchRoot, absPath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;

    // ui-state.json is the single source of truth for the active canvas, the
    // active agent, and which system panels are open (escape mode, the canvas
    // picker, canvas/component requirements). The client (PUT /workspace/), an
    // agent, or an external editor may write it. Apply any canvas/agent switch it
    // requests, then push the panel state to every client.
    if (rel === 'ui-state.json') {
        applyActiveCanvasFromFile();
        applyActiveAgentFromFile();
        broadcast({ type: 'ui-state', state: uiStateFromFile() });
        return false;
    }

    // A direct child of the workspace is canvas-level: a canvas folder
    // appearing or disappearing changes the switcher.
    if (!rel.includes('/')) {
        if (isCanvasCandidateFilename(rel)) {
            broadcast({ type: 'canvases-changed' });
        }
        return false;
    }

    // Everything else is content; only the active canvas is on screen, so
    // only its files drive a re-render.
    const activeName = canvasName(CANVAS_PATH);
    if (!activeName || !rel.startsWith(activeName + '/')) return false;

    // The page has a <liquidos-file> watching each component file; tell it to
    // re-render (component edits repaint through their own morph).
    broadcast({ type: 'workspace-file', path: rel });

    // canvas.js (presentation), the relationships under relationships/, and
    // index.json (the component list) have no element watching them — they
    // re-render through the graph.
    return rel === activeName + '/canvas.js'
        || rel.startsWith(activeName + '/relationships/')
        || rel === activeName + '/index.json';
};

const startWorkspaceWatch = () => {
    if (workspaceSubscription) return;
    parcelWatcher.subscribe(workspaceWatchRoot, (error, events) => {
        if (error) {
            // FSEvents can overflow its kernel buffer under a burst and ask
            // for a re-scan; we can't know which events were missed. The files
            // are the source of truth, so re-sync every client from disk:
            // refresh the canvas list and reload the active canvas. The
            // subscription stays live — this is recovery, not a teardown.
            logHermesError('watch', error, { message: 'workspace watcher dropped events; re-syncing from disk' });
            broadcast({ type: 'canvases-changed' });
            scheduleGraphRefresh();
            return;
        }
        let needGraphRefresh = false;
        for (const event of events) {
            if (dispatchWorkspaceEvent(event.path)) needGraphRefresh = true;
        }
        if (needGraphRefresh) scheduleGraphRefresh();
    }, { ignore: ['node_modules', '.git', '.liquidos'] })
        .then(sub => { workspaceSubscription = sub; })
        .catch(error => logHermesError('watch', error, { message: 'workspace watcher subscribe failed' }));
};

const stopWorkspaceWatch = () => {
    if (!workspaceSubscription) return;
    const sub = workspaceSubscription;
    workspaceSubscription = null;
    sub.unsubscribe().catch(() => {});
};

const readBody = req =>
    new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });

const appendOutput = async req => {
    const body = JSON.parse(await readBody(req));
    const scope = String(body.scope || '').trim();
    const prompt = String(body.prompt || '').trim();
    const resolvedScope = scope ? resolveCanvasReference(scope) : CANVAS_PATH;
    const isCanvasPrompt = !scope || resolvedScope === CANVAS_PATH;

    if (!prompt) {
        throw new Error('Prompt requires prompt text');
    }

    logServer('callback', isCanvasPrompt ? 'received canvas prompt' : 'received scoped prompt', {
        canvas: CANVAS_PATH,
        scope: isCanvasPrompt ? CANVAS_PATH : absoluteScope(scope),
        resolvedScope: isCanvasPrompt ? CANVAS_PATH : resolvedScope,
        prompt
    });

    await outputQueue.appendOutputJob({
        id: 'output-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        scope: isCanvasPrompt ? CANVAS_PATH : absoluteScope(scope),
        status: 'pending',
        createdAt: new Date().toISOString(),
        componentKey: isCanvasPrompt ? CANVAS_PATH : absoluteScope(scope),
        prompt
    });
};


const componentFeatureFile = componentPath =>
    path.join(canvasGraph.componentFolderPath(componentPath), 'feature-requirements.txt');

const readComponentFeatureText = componentPath => {
    const file = componentFeatureFile(componentPath);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

// readComponentFeatures returns the file's content plus presence/error
// metadata so the client can distinguish "file missing" (Repair) from
// "file present but empty" (Generate). Read errors fall under Repair too.
const readComponentFeatures = componentPath => {
    const file = componentFeatureFile(componentPath);
    if (!fs.existsSync(file)) return { present: false, text: '', error: null };
    try {
        return { present: true, text: fs.readFileSync(file, 'utf8'), error: null };
    } catch (error) {
        return { present: true, text: '', error: error.message };
    }
};

const readComponentFeatureTitle = componentPath => {
    const folder = canvasGraph.componentFolderPath(componentPath);
    try {
        const view = JSON.parse(fs.readFileSync(path.join(folder, 'view.json'), 'utf8'));
        if (typeof view.title === 'string' && view.title.trim()) return view.title.trim();
    } catch { /* fall through */ }
    // Fallback: prettify the folder basename ("bitcoin-price-chart" → "Bitcoin Price Chart").
    return path.basename(folder)
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
};

const writeComponentFeatureText = (componentPath, text) => {
    fs.mkdirSync(path.dirname(componentFeatureFile(componentPath)), { recursive: true });
    fs.writeFileSync(componentFeatureFile(componentPath), String(text || ''), 'utf8');
};

const appendInternalOutputJob = async ({ scope, prompt, event }) => {
    await outputQueue.appendOutputJob({
        id: 'output-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        scope,
        status: 'pending',
        createdAt: new Date().toISOString(),
        componentKey: scope,
        prompt,
        ...(event ? { event } : {})
    });
    outputQueue.feedHermesOutput();
    broadcastQueueState();
};

// Crash recovery is two phases, both dispatched on a normal boot — there is no
// special server mode. The harness does NOT decide the fix and names no culprit;
// it hands the agent the crash and points it at the git log, where every prior
// attempt left its reasoning. The scope is the workspace root: recovery is a
// workspace-level concern, not a single canvas's. Each phase is committed by the
// job machinery (RECOVER_EVENT, then FIX_EVENT), and that timeline is the only
// state used to decide what is still owed (see crash-recovery.js).
//
// Phase 1 — make it bootable. A crash leaves a marker; on the next boot we hand
// the agent the crash and ask for the minimal transitory change that stops it.
// When that job commits RECOVER_EVENT, the queue chains into Phase 2 (see the
// setProcessJob wrapper below), so the permanent fix follows without a restart.
const dispatchCrashRecovery = () => {
    const report = crashRecovery.consumeCrashReport(WORKSPACE_PATH);
    if (report) {
        // Hold service spawns until Phase 1 commits, so the offender can't be
        // re-spawned and re-crash the server while the agent is repairing.
        recovering = true;
        // Run Phase 1 only once the recovery screen is watching /agent/stream,
        // so it sees the agent's activity live — simpler than replaying it. The
        // app shows the screen the instant it detects the crash, so it connects
        // within a beat of the server coming up. A fallback runs Phase 1 anyway
        // if no screen ever connects, so recovery is never stuck.
        pendingCrashDispatch = () => {
            logServer('crash', 'phase 1: dispatching make-bootable', { reason: report.reason || null });
            appendInternalOutputJob({
                scope: WORKSPACE_PATH,
                event: crashRecovery.RECOVER_EVENT,
                prompt: crashRecovery.crashRepairPrompt({ reason: report.reason, stack: report.stack })
            }).catch(error => logHermesError('crash', error, { message: 'phase 1 dispatch failed' }));
        };
        if (agentStreamClients.size > 0) firePendingCrashDispatch();
        else setTimeout(firePendingCrashDispatch, 8000);
        return;
    }
    dispatchPermanentFixIfOwed();
};

// Phase 2 — make it permanent. If the latest crash recovery has not yet been
// followed by a permanent-fix attempt (read off the git timeline, no extra
// state), hand a fresh agent the job of fixing the cause for real and undoing
// the transitory change. One attempt per recovery: the job commits FIX_EVENT,
// which closes the cycle so it won't re-dispatch. If the fix doesn't hold and
// the workspace crashes again, that is a new recovery and a new Phase 2. The
// server only dispatches; the agent does the work, proving it in a sandbox.
const dispatchPermanentFixIfOwed = () => {
    if (!crashRecovery.permanentFixOwed(activityPersistence.recentEvents())) return;
    logServer('crash', 'phase 2: dispatching permanent fix');
    appendInternalOutputJob({
        scope: WORKSPACE_PATH,
        event: crashRecovery.FIX_EVENT,
        prompt: crashRecovery.permanentFixPrompt()
    }).catch(error => logHermesError('crash', error, { message: 'phase 2 dispatch failed' }));
};

const componentFeaturePrompt = ({ componentScope, before, after }) => [
    'The user edited the feature requirements for this component.',
    '',
    'Component:',
    componentScope,
    '',
    'Previous requirements:',
    before || '(none)',
    '',
    'Updated requirements:',
    after || '(none)',
    '',
    'Review the actual component before changing anything.',
    'Keep feature-requirements.txt user-facing, concise, plain-language, and faithful to what the component does or is meant to do. It is a plain text file with no title — the title comes from view.json. One requirement per line, each line a bullet beginning with "- ".',
    "If the requirements and implementation disagree, resolve the mismatch by updating the implementation, the requirements, or both, based on the user's intent.",
    'Do not add unrelated capabilities or preserve inaccurate requirements.'
].join('\n');

const canvasRequirementsPrompt = ({ canvasName, canvasScope, before, after }) => [
    'The user edited the requirements for this canvas.',
    '',
    'Canvas:',
    canvasName,
    '',
    'Previous requirements:',
    before || '(none)',
    '',
    'Updated requirements:',
    after || '(none)',
    '',
    'Reconcile the canvas to match the updated requirements:',
    '- Add, remove, or modify components in index.json as the prose dictates.',
    '- Add, remove, or modify relationships under ' + canvasScope + '/relationships/ (see skills/relationships).',
    '- Update individual components\' feature-requirements.txt files when canvas-level intent changes their roles.',
    'Keep feature-requirements.txt user-facing, plain-language, and faithful to what the canvas is for. Write the requirements as bullets, each line beginning with "- ".',
    "If the requirements and the actual canvas disagree, resolve the mismatch based on the user's intent."
].join('\n');

const streamFile = (req, res, file, type = 'application/octet-stream') => {
    const stat = fs.statSync(file);
    const range = req.headers.range;

    if (!range) {
        res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache'
        });
        fs.createReadStream(file).pipe(res);
        return;
    }

    const [startText, endText] = range.replace('bytes=', '').split('-');
    const start = Number.parseInt(startText, 10);
    const end = endText ? Number.parseInt(endText, 10) : stat.size - 1;

    res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file, { start, end }).pipe(res);
};

const staticPath = pathname => {
    const file = path.resolve(ROOT, pathname === '/' ? 'index.html' : '.' + decodeURIComponent(pathname));
    return file.startsWith(ROOT + path.sep) || file === ROOT ? file : undefined;
};

// --- New-shape endpoints (additive deltas) -----------------------------
// These give the new lib elements (<liquidos-file>, <liquidos-component>)
// what they need: direct workspace file access and process spawn/kill.
// The legacy harness routes below are unchanged.

const newShapeServices = new Map();
const newShapeNewServiceId = () => 'svc_' + crypto.randomBytes(6).toString('hex');
const newShapeDispatchLabelFor = label => {
    const s = String(label || 'service');
    const parts = s.split('/').filter(Boolean);
    if (parts.length >= 2 && parts[parts.length - 1].includes('.')) return parts[parts.length - 2];
    return parts[parts.length - 1] || 'service';
};
const newShapeSafeName = s => String(s || 'service').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'service';
const newShapeNewDispatchId = label => newShapeSafeName(newShapeDispatchLabelFor(label)) + '-' + crypto.randomBytes(4).toString('hex');

const newShapeDescendantsOf = pid => {
    let out;
    try { out = childProcess.execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }); }
    catch { return []; }
    const direct = out.split('\n').map(s => s.trim()).filter(Boolean).map(Number);
    const all = [...direct];
    for (const c of direct) all.push(...newShapeDescendantsOf(c));
    return all;
};

// Kill everything THIS server spawned — component services, the agent, and
// anything they spawned in turn (sandbox servers, the agent's own children) —
// by walking our own descendant tree. Broader than newShapeServices, which
// only tracks component services and so left the agent to stray on shutdown.
const newShapeKillOwnSubtree = () => {
    for (const pid of newShapeDescendantsOf(process.pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
    }
};

// A prior server for this workspace that died by crash / SIGKILL / the app
// being force-quit can leave detached workers (services, sandbox servers, a
// stray agent) re-parented to launchd — nothing the dying server runs is
// guaranteed, so the NEXT server cleans the slate before spawning fresh.
// Scoped to worker-looking commands under WORKSPACE_PATH; never the GUI app
// or our own process tree.
const newShapeReapStrayWorkspaceProcesses = () => {
    let out;
    try { out = childProcess.execFileSync('pgrep', ['-f', WORKSPACE_PATH], { encoding: 'utf8' }); }
    catch { return; } // no matches
    const ours = new Set([process.pid, process.ppid, ...newShapeDescendantsOf(process.pid)]);
    for (const line of out.split('\n')) {
        const pid = Number(line.trim());
        if (!pid || ours.has(pid)) continue;
        let cmd = '';
        try { cmd = childProcess.execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim(); }
        catch { continue; }
        if (cmd.includes('LiquidOS.app/Contents/MacOS')) continue; // never the app itself
        const looksLikeWorker = /\bnode\b/.test(cmd) || /\.sh(\s|$)/.test(cmd) || /\b(claude|codex|hermes|pi)\b/.test(cmd);
        if (!looksLikeWorker) continue;
        try { process.kill(pid, 'SIGKILL'); } catch {}
    }
};

const newShapeKillService = (id) => {
    const svc = newShapeServices.get(id);
    if (!svc) return false;
    // Drop this producer's server-side sniffer so a half-open marker left
    // by a mid-stream kill can't bleed into the next spawn that reuses the
    // same source key.
    if (svc.source) serverSniffers.delete(svc.source);
    const root = svc.child.pid;
    const tree = [root, ...newShapeDescendantsOf(root)];
    for (const pid of tree) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    setTimeout(() => {
        const still = [root, ...newShapeDescendantsOf(root)];
        for (const pid of still) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }, 1500);
    newShapeServices.delete(id);
    return true;
};

const newShapeShutdown = code => {
    newShapeKillOwnSubtree();
    process.exit(code);
};
process.on('SIGINT', () => newShapeShutdown(0));
process.on('SIGTERM', () => newShapeShutdown(0));
// Backstop for any exit that doesn't go through newShapeShutdown (an explicit
// process.exit elsewhere, normal end). Synchronous-only, which the tree walk
// is. Can't help on SIGKILL/force-quit — startup reap covers those.
process.on('exit', () => newShapeKillOwnSubtree());

const newShapeGuardAbs = rel => {
    const cleaned = String(rel || '').replace(/^\/+/, '');
    const abs = path.resolve(WORKSPACE_PATH, cleaned);
    if (abs !== WORKSPACE_PATH && !abs.startsWith(WORKSPACE_PATH + path.sep)) return null;
    return abs;
};

const newShapeMimeFor = file => {
    const ext = path.extname(file).toLowerCase();
    const m = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml',
        '.txt': 'text/plain; charset=utf-8',
        '.wasm': 'application/wasm'
    };
    return m[ext] || 'application/octet-stream';
};

const newShapeReadBody = req => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
});

const newShapeSendJson = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');

        // --- New-shape: direct workspace file access -----------------------
        // /workspace/<rel> is reserved for file I/O. Migration and
        // batch-write endpoints live under their own roots so this
        // namespace stays unambiguous.
        if (url.pathname.startsWith('/workspace/')) {
            const rel = decodeURIComponent(url.pathname.slice('/workspace/'.length));
            const abs = newShapeGuardAbs(rel);
            if (!abs) { res.writeHead(400); res.end('path escapes workspace'); return; }
            if (req.method === 'GET') {
                if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); res.end(); return; }
                res.writeHead(200, { 'content-type': newShapeMimeFor(abs) });
                fs.createReadStream(abs).pipe(res);
                return;
            }
            if (req.method === 'HEAD') {
                if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); res.end(); return; }
                const stat = fs.statSync(abs);
                res.writeHead(200, {
                    'content-type': newShapeMimeFor(abs),
                    'content-length': stat.size,
                    'last-modified': stat.mtime.toUTCString()
                });
                res.end();
                return;
            }
            if (req.method === 'PUT') {
                const body = await newShapeReadBody(req);
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                const tmp = abs + '.tmp-' + process.pid + '-' + Date.now();
                fs.writeFileSync(tmp, body);
                fs.renameSync(tmp, abs);
                newShapeSendJson(res, 200, { ok: true });
                return;
            }
        }

        if (req.method === 'POST' && url.pathname === '/spawn') {
            // While Phase 1 of a crash recovery is making the workspace bootable,
            // hold off spawning any service: we don't know which one took the
            // server down (the harness names no culprit), so spawning the
            // offender now would just crash the server again mid-repair. Phase 1
            // disables or fixes it; the re-render that follows starts the
            // survivors. Reply 200 so the client treats it as a no-op, not an error.
            if (recovering) { newShapeSendJson(res, 200, { deferred: true }); return; }
            const body = JSON.parse(await newShapeReadBody(req) || '{}');
            const abs = newShapeGuardAbs(body.script);
            if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
                newShapeSendJson(res, 400, { error: 'script does not exist' }); return;
            }
            // Idempotent per script path — kill any prior service for the
            // same script before spawning, so page refreshes don't pile up.
            for (const [id, svc] of newShapeServices.entries()) {
                if (svc.abs === abs) newShapeKillService(id);
            }
            const dispatchId = body.dispatchId || newShapeNewDispatchId(body.label);

            const child = childProcess.spawn(abs, [dispatchId, ...(Array.isArray(body.args) ? body.args : [])], {
                cwd: path.dirname(abs),
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true,
                env: { ...process.env, LIQUIDOS_DISPATCH_ID: dispatchId, ...(body.env || {}) }
            });
            const id = newShapeNewServiceId();
            newShapeServices.set(id, { child, label: body.label || path.basename(abs), dispatchId, abs, source: 'service:' + body.script });
            child.stdout.on('data', d => {
                const text = d.toString();
                // A service's stdout is its view-patch channel: feed it to
                // the serializer under the service's script path — the
                // stable key the client knows before spawning, so it can
                // confine the service to its component before any slice
                // arrives. The server frames it in isolation from the agent
                // and other services. Diagnostics belong on stderr (below),
                // which stays in the server log.
                serializeProducerChunk('service:' + body.script, text);
                process.stdout.write('[' + id + '] ' + text.replace(/\n$/, '') + '\n');
            });
            child.stderr.on('data', d => process.stderr.write('[' + id + '] ' + d.toString().replace(/\n$/, '') + '\n'));
            // A service that can't even launch (a non-executable script, a
            // missing interpreter, anything spawn rejects) is treated like any
            // other service that takes the server down: we do NOT catch the
            // 'error' event, so it becomes an uncaught exception and recovery
            // handles it. One general rule — a service the server can't run is
            // a crash to recover from.
            child.on('exit', () => { newShapeServices.delete(id); });
            newShapeSendJson(res, 200, { id, pid: child.pid, dispatchId });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/kill') {
            const body = JSON.parse(await newShapeReadBody(req) || '{}');
            const ok = newShapeKillService(body.id);
            newShapeSendJson(res, ok ? 200 : 404, { ok });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });
            clients.add(res);
            res.write('data: ' + JSON.stringify(queueStatePayload()) + '\n\n');
            req.on('close', () => clients.delete(res));
            return;
        }


        // The crash-recovery screen. Served same-origin (the app loads it by URL,
        // not as an HTML string) so its EventSource('/agent/stream') connects
        // cleanly. It shows the agent's human-friendly #agent-activity — the same
        // status the prompt bar shows — by applying only the slices targeting
        // #agent-activity, mirroring the canvas's page-chrome renderer. Connecting
        // here is also what releases Phase 1 (see dispatchCrashRecovery), so the
        // screen is watching from the agent's first slice.
        if (req.method === 'GET' && url.pathname === '/recovery') {
            send(res, 200, RECOVERY_PAGE_HTML, 'text/html; charset=utf-8');
            return;
        }

        // Unified agent SSE stream. Carries:
        //   debug-ready / debug-snapshot / debug-line / debug-status
        //     — the line-buffered, ANSI-stripped per-line events the
        //       debug rail consumes.
        //   raw
        //     — every chunk the agent emits via host.output, verbatim.
        //       The lqpatch sniffer in index.html reads from here.
        if (req.method === 'GET' && url.pathname === '/agent/stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            agentStreamClients.add(res);
            res.write('event: debug-ready\n');
            res.write('data: {"type":"debug-ready"}\n\n');
            res.write('event: debug-snapshot\n');
            res.write('data: ' + JSON.stringify({ type: 'debug-snapshot', snapshot: currentAgentDebugSnapshot() }) + '\n\n');
            req.on('close', () => agentStreamClients.delete(res));
            // The recovery screen just tuned in — now run Phase 1, so it sees the
            // agent's activity from the first slice.
            if (pendingCrashDispatch) firePendingCrashDispatch();
            return;
        }

        if (req.method === 'GET' && url.pathname === '/agents/probe') {
            send(res, 200, JSON.stringify(activeRuntime.probe()), 'application/json; charset=utf-8');
            return;
        }

        // Sharing is now per-instance:
        //   <canvas>/share.json                                — { shared: bool }
        //   <canvas>/components/<name>/share.json              — { shared: bool } (opt-out)
        // A canvas with shared=true publishes; all its components inherit that
        // unless their own share.json explicitly says { shared: false }. There
        // is no workspace-level master toggle any more; opting in is per-artifact.
        const readShareFlag = (file) => {
            try {
                if (!fs.existsSync(file)) return null;
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
                return typeof parsed.shared === 'boolean' ? parsed.shared : null;
            } catch { return null; }
        };
        const writeShareFlag = (file, shared) => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ shared: Boolean(shared) }, null, 2) + '\n');
        };
        const canvasShareFile = (canvasName) =>
            path.join(WORKSPACE_PATH, canvasName, 'share.json');
        const componentShareFile = (componentAbsPath) =>
            path.join(componentAbsPath, 'share.json');
        // Share scripts. Each owns its piece of the share.json/feed.json
        // shape; the endpoint just decides which one to call.
        const runShareScript = (script, args) => {
            const { spawnSync } = require('node:child_process');
            const scriptPath = path.join(ROOT, 'skills', 'sharing', 'scripts', script);
            const result = spawnSync('bash', [scriptPath, WORKSPACE_PATH, ...args], { encoding: 'utf8' });
            if (result.status !== 0) {
                return { ok: false, error: (result.stderr || result.stdout || 'unknown').trim() };
            }
            return { ok: true };
        };

        // /share endpoint family. One namespace, HTTP verbs do the work.
        //
        //   GET    /share                       — list bundles (?q=)
        //   POST   /share                       — install a bundle
        //                                         (body: { peerId, hash })
        //   GET    /share/<canvas>              — read canvas share state
        //   PUT    /share/<canvas>              — share local canvas
        //   DELETE /share/<canvas>              — unshare local canvas
        //   GET    /share/<canvas>/<component>  — read component state
        //   PUT    /share/<canvas>/<component>  — opt component back in
        //   DELETE /share/<canvas>/<component>  — opt component out
        if (url.pathname === '/share' || url.pathname.startsWith('/share/')) {
            const parts = url.pathname.split('/').filter(Boolean);  // ['share', ...]

            // --- GET /share — list -------------------------------------
            if (req.method === 'GET' && parts.length === 1) {
                // Browsing is a networking action: bring the node up (once) so
                // peer feeds can be discovered. A no-share workspace that never
                // browses stays dark.
                const net = await network();
                await net.ensure();
                const query = (url.searchParams.get('q') || '').trim().toLowerCase();
                const matchesQuery = (bundle) => {
                    if (!query) return true;
                    const haystack = [
                        bundle.name || '',
                        bundle.canvasRequirements || '',
                        Array.isArray(bundle.components)
                            ? bundle.components.map(c => typeof c === 'string' ? c : (c?.name || '')).join(' ')
                            : ''
                    ].join(' ').toLowerCase();
                    return haystack.includes(query);
                };
                const results = [];
                const feedFile = path.join(WORKSPACE_PATH, '.share', 'feed.json');
                if (fs.existsSync(feedFile)) {
                    try {
                        const localFeed = JSON.parse(fs.readFileSync(feedFile, 'utf8'));
                        for (const bundle of (localFeed.bundles || [])) {
                            if (matchesQuery(bundle)) results.push({ ...bundle, peerId: null });
                        }
                    } catch { /* fall through */ }
                }
                const feed = net.peerFeed();
                if (feed) {
                    for (const [, entry] of feed.cache) {
                        const bundles = entry.feed && Array.isArray(entry.feed.bundles) ? entry.feed.bundles : [];
                        for (const bundle of bundles) {
                            if (matchesQuery(bundle)) results.push({ ...bundle, peerId: entry.peerId });
                        }
                    }
                }
                send(res, 200, JSON.stringify({ results }), 'application/json; charset=utf-8');
                return;
            }

            // --- POST /share — install ---------------------------------
            if (req.method === 'POST' && parts.length === 1) {
                let body;
                try { body = JSON.parse(await readBody(req) || '{}'); }
                catch { send(res, 400, 'invalid json'); return; }
                const peerId = body.peerId || null;
                const hash = body.hash || '';
                if (!/^sha256-[0-9a-f]{64}$/.test(hash)) { send(res, 400, 'invalid hash'); return; }

                let entry = null;
                if (!peerId) {
                    const feedFile = path.join(WORKSPACE_PATH, '.share', 'feed.json');
                    let feed = { bundles: [] };
                    try { feed = JSON.parse(fs.readFileSync(feedFile, 'utf8')); } catch {}
                    entry = (feed.bundles || []).find(b => b.hash === hash);
                    if (!entry) { send(res, 404, 'bundle not found in local feed'); return; }
                } else {
                    const net = await network();
                    await net.ensure();
                    const feed = net.peerFeed();
                    if (!net.node() || !feed) {
                        send(res, 503, 'network not running'); return;
                    }
                    for (const [pid, peerEntry] of feed.cache) {
                        if (pid !== peerId) continue;
                        const bundles = peerEntry.feed && Array.isArray(peerEntry.feed.bundles) ? peerEntry.feed.bundles : [];
                        entry = bundles.find(b => b.hash === hash) || null;
                        if (entry) break;
                    }
                    if (!entry) { send(res, 404, 'bundle not in cached feed for that peer'); return; }
                }

                const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'liquidos-install-'));
                const bundleSrc = path.join(tempDir, entry.name);
                fs.mkdirSync(bundleSrc, { recursive: true });
                fs.writeFileSync(path.join(bundleSrc, 'feature-requirements.txt'), entry.canvasRequirements || '');
                for (const comp of (entry.components || [])) {
                    if (!comp || typeof comp.name !== 'string') continue;
                    const compDir = path.join(bundleSrc, 'components', comp.name);
                    fs.mkdirSync(compDir, { recursive: true });
                    fs.writeFileSync(path.join(compDir, 'feature-requirements.txt'), comp.requirements || '');
                }

                const { spawnSync } = require('node:child_process');
                const installScript = path.join(ROOT, 'skills', 'sharing', 'scripts', 'install.sh');
                const targetName = entry.name + '-' + hash.slice('sha256-'.length, 'sha256-'.length + 6);
                const result = spawnSync('bash', [installScript, bundleSrc, WORKSPACE_PATH, targetName], {
                    encoding: 'utf8'
                });
                try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
                if (result.status !== 0) {
                    send(res, 500, 'install failed: ' + (result.stderr || result.stdout || 'unknown'));
                    return;
                }
                const lines = (result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
                let summary;
                try { summary = JSON.parse(lines[lines.length - 1]); } catch { summary = {}; }
                const newCanvasName = summary.canvas || targetName;
                const newCanvasPath = summary.canvasPath || path.join(WORKSPACE_PATH, newCanvasName);

                // Queue an agent dispatch scoped to the new canvas. The
                // agent's existing skills know what to do with scaffolded
                // components that have feature-requirements.txt and a
                // Loading… placeholder; this just kicks off the build so
                // the user doesn't have to type "build it" after install.
                try {
                    await outputQueue.appendOutputJob({
                        id: 'output-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
                        scope: newCanvasPath,
                        status: 'pending',
                        createdAt: new Date().toISOString(),
                        componentKey: newCanvasPath,
                        prompt: 'Build this canvas and its components.'
                    });
                    outputQueue.feedHermesOutput();
                } catch (error) {
                    logServer('network', 'install dispatch enqueue failed', {
                        canvas: newCanvasName, error: error.message
                    });
                }

                send(res, 200, JSON.stringify({
                    canvas: newCanvasName,
                    canvasPath: newCanvasPath,
                    components: summary.components || null
                }), 'application/json; charset=utf-8');
                return;
            }

            // --- /share/<canvas> ---------------------------------------
            if (parts.length === 2) {
                const canvasName = decodeURIComponent(parts[1]);
                if (!canvasName) { send(res, 400, 'canvas required'); return; }

                if (req.method === 'GET') {
                    const flag = readShareFlag(canvasShareFile(canvasName));
                    send(res, 200, JSON.stringify({ shared: flag === true }), 'application/json; charset=utf-8');
                    return;
                }

                const canvasPath = path.join(WORKSPACE_PATH, canvasName);
                if (!pathIsInside(canvasPath, WORKSPACE_PATH) || !fs.existsSync(canvasPath) || !fs.statSync(canvasPath).isDirectory()) {
                    send(res, 404, 'canvas not found');
                    return;
                }

                if (req.method === 'PUT') {
                    const result = runShareScript('share.sh', [canvasName]);
                    if (!result.ok) { send(res, 500, 'share failed: ' + result.error); return; }
                    // Sharing opts this workspace in: start the node so peers
                    // can reach it. Await so it's up (and /network/status
                    // reports a multiaddr) by the time the toggle resolves.
                    await (await network()).ensure();
                    send(res, 200, JSON.stringify({ shared: true }), 'application/json; charset=utf-8');
                    return;
                }
                if (req.method === 'DELETE') {
                    const result = runShareScript('unshare.sh', [canvasName]);
                    if (!result.ok) { send(res, 500, 'unshare failed: ' + result.error); return; }
                    send(res, 200, JSON.stringify({ shared: false }), 'application/json; charset=utf-8');
                    return;
                }
            }

            // --- /share/<canvas>/<component> ---------------------------
            if (parts.length === 3) {
                const canvasName = decodeURIComponent(parts[1]);
                const componentName = decodeURIComponent(parts[2]);
                if (!canvasName || !componentName) { send(res, 400, 'canvas and component required'); return; }

                const componentFolder = path.join(WORKSPACE_PATH, canvasName, 'components', componentName);
                if (!pathIsInside(componentFolder, WORKSPACE_PATH) || !fs.existsSync(componentFolder)) {
                    send(res, 404, 'component not found');
                    return;
                }

                if (req.method === 'GET') {
                    const canvasFlag = readShareFlag(canvasShareFile(canvasName));
                    const compFlag = readShareFlag(componentShareFile(componentFolder));
                    const effective = canvasFlag === true && compFlag !== false;
                    send(res, 200, JSON.stringify({
                        shared: effective,
                        canvasShared: canvasFlag === true,
                        componentOverride: compFlag
                    }), 'application/json; charset=utf-8');
                    return;
                }

                const writeOptAndRepublish = (sharedValue) => {
                    writeShareFlag(componentShareFile(componentFolder), sharedValue);
                    if (readShareFlag(canvasShareFile(canvasName)) === true) {
                        runShareScript('share.sh', [canvasName]);
                        network().then(net => net.ensure());
                    }
                };

                if (req.method === 'PUT') {
                    writeOptAndRepublish(true);
                    send(res, 200, JSON.stringify({ shared: true }), 'application/json; charset=utf-8');
                    return;
                }
                if (req.method === 'DELETE') {
                    writeOptAndRepublish(false);
                    send(res, 200, JSON.stringify({ shared: false }), 'application/json; charset=utf-8');
                    return;
                }
            }
        }

        if (req.method === 'GET' && url.pathname === '/network/status') {
            // Read-only: report status without ever starting the node.
            const status = (await network()).status();
            send(res, 200, JSON.stringify(status), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/network/dial') {
            // Manually dial a peer by multiaddr. Mostly a debug / test
            // affordance: in production, peers find each other through
            // the libp2p DHT bootstrap, but in tests with two local
            // nodes we want a direct connection without waiting on the
            // public DHT to route us together.
            const net = await network();
            await net.ensure();
            const node = net.node();
            if (!node) { send(res, 503, 'network not running'); return; }
            let body;
            try { body = JSON.parse(await readBody(req) || '{}'); }
            catch { send(res, 400, 'invalid json'); return; }
            const target = String(body.multiaddr || '').trim();
            if (!target) { send(res, 400, 'multiaddr required'); return; }
            try {
                const { multiaddr } = await import('@multiformats/multiaddr');
                await node.dial(multiaddr(target));
                send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
            } catch (error) {
                send(res, 502, 'dial failed: ' + (error?.message || error));
            }
            return;
        }

        if (req.method === 'GET' && url.pathname === '/debug/agent') {
            send(res, 200, JSON.stringify({
                ...currentAgentDebugSnapshot(),
                canvas: canvasName(CANVAS_PATH)
            }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'GET' && url.pathname === '/input') {
            const rendered = canvasGraph.renderedInput();
            send(res, 200, JSON.stringify(rendered), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'GET' && url.pathname === '/canvases') {
            send(res, 200, JSON.stringify({
                current: canvasName(CANVAS_PATH),
                currentPath: CANVAS_PATH,
                canvases: canvasFiles.availableCanvases()
            }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/canvas/requirements') {
            // Mirror of /component/<path>/features for the canvas-level
            // requirements file. Writes the new content, and — only when it
            // changed — dispatches the agent with a reconcile prompt so
            // edits to feature-requirements.txt build the canvas to match
            // (add/remove components, materialize relationships, etc.).
            const body = JSON.parse(await readBody(req));
            const requestedCanvas = String(body.canvas || '');
            if (!requestedCanvas) {
                send(res, 400, 'canvas required');
                return;
            }
            const canvasPath = path.join(WORKSPACE_PATH, requestedCanvas);
            if (!pathIsInside(canvasPath, WORKSPACE_PATH) || !fs.existsSync(canvasPath) || !fs.statSync(canvasPath).isDirectory()) {
                send(res, 404, 'canvas not found');
                return;
            }
            const requirementsPath = path.join(canvasPath, 'feature-requirements.txt');
            let before = '';
            try { before = fs.readFileSync(requirementsPath, 'utf8'); } catch { before = ''; }
            const after = String(body.text || '');
            const changed = before !== after;
            if (changed) {
                fs.writeFileSync(requirementsPath, after, 'utf8');
                await appendInternalOutputJob({
                    scope: canvasPath,
                    prompt: canvasRequirementsPrompt({
                        canvasName: requestedCanvas,
                        canvasScope: canvasPath,
                        before,
                        after
                    })
                });
            }
            send(res, 200, JSON.stringify({ changed }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/canvases') {
            const body = JSON.parse(await readBody(req));
            const name = canvasFiles.createCanvas(body.name);

            // Create the folder only — making it active is a ui-state.json write,
            // which the client does next by switching to the returned name. That
            // keeps ui-state.json's single-writer story intact (the server never
            // writes the canvas pointer).
            activityPersistence.persistActivity({
                event: `User did create canvas with name '${String(name).replace(/[\n\r]+/g, ' ').replace(/'/g, "\\'")}'`,
                scope: path.join(WORKSPACE_PATH, name),
                prompt: '',
                agentResponse: 'none',
                mode: 'done'
            });
            // fs.watch may miss the in-process directory mutation, so emit
            // canvases-changed explicitly to refresh every switcher.
            broadcast({ type: 'canvases-changed' });
            send(res, 201, JSON.stringify({
                name,
                canvases: canvasFiles.availableCanvases()
            }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/output') {
            await appendOutput(req);
            outputQueue.feedHermesOutput();
            broadcastQueueState();
            send(res, 204, '');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/diagnostics') {
            try {
                const body = JSON.parse(await readBody(req) || '{}');
                const componentPath = String(body.componentPath || '');
                const category = String(body.category || '');
                const data = body.data && typeof body.data === 'object' ? body.data : {};

                if (!componentPath || !category) {
                    send(res, 400, 'componentPath and category required');
                    return;
                }

                const absolute = resolveCanvasReference(componentPath);

                // No subject, no diagnostic. A deleted component/relationship
                // writing a late diagnostic during teardown would make
                // componentFolderPath dirname up into the collection root
                // (components/ or relationships/) and create a stray
                // `diagnostics/` folder there — which the relationship scanner
                // then mis-loads as a phantom relationship. Skip when the
                // subject is gone.
                if (!fs.existsSync(absolute)) {
                    send(res, 200, JSON.stringify({ skipped: 'no such component' }));
                    return;
                }

                const componentDir = canvasGraph.componentFolderPath(absolute);

                if (!pathIsInside(componentDir, CANVAS_PATH)) {
                    send(res, 403, 'Component outside canvas');
                    return;
                }

                canvasGraph.updateDiagnostics(componentDir, category, data);
                // Diagnostics files are deliberately outside the harness's
                // file-watcher refresh path (they'd thrash on every status
                // update). Broadcast here so the client refetches /input
                // and the Repair button's needsRepair tracks state.
                broadcast();
                send(res, 204, '');
            } catch (error) {
                send(res, 400, error.message);
            }
            return;
        }

        if (req.method === 'POST' && url.pathname === '/writes') {
            // One endpoint for any workspace write — inline content
            // (browser persisting state) or files copied from a sandbox
            // (agent landing a verified batch). Each write entry takes one
            // of two shapes:
            //   { path, content }        — inline; content is a JSON-encodable
            //                              value, written as JSON to path.
            //   { path, from }           — copy; from is absolute or
            //                              sandbox-relative if `sandbox` is set.
            // The watcher pauses for the full batch and emits one refresh
            // when the writes finish, so the client sees one coherent update.
            let body;
            try {
                body = JSON.parse(await readBody(req) || '{}');
            } catch (error) {
                send(res, 400, 'invalid json: ' + error.message);
                return;
            }

            const sandbox = body.sandbox != null ? String(body.sandbox) : null;
            const writes = Array.isArray(body.writes) ? body.writes : null;

            if (sandbox && !path.isAbsolute(sandbox)) {
                send(res, 400, 'sandbox must be an absolute path when provided');
                return;
            }
            if (sandbox && (!fs.existsSync(sandbox) || !fs.statSync(sandbox).isDirectory())) {
                send(res, 400, 'sandbox path does not exist');
                return;
            }
            if (!writes || writes.length === 0) {
                send(res, 400, 'writes must be a non-empty array');
                return;
            }

            const planned = [];
            for (const write of writes) {
                if (!write || typeof write !== 'object') {
                    send(res, 400, 'each write must be an object');
                    return;
                }
                const rel = typeof write.path === 'string' ? write.path : '';
                if (!rel || path.isAbsolute(rel)) {
                    send(res, 400, 'write.path must be a non-empty workspace-relative string');
                    return;
                }
                const toAbs = path.resolve(WORKSPACE_PATH, rel);
                if (!pathIsInside(toAbs, WORKSPACE_PATH)) {
                    send(res, 400, 'write.path escapes workspace: ' + rel);
                    return;
                }
                if (write.content !== undefined) {
                    planned.push({ rel, toAbs, kind: 'inline', content: write.content });
                } else if (typeof write.from === 'string' && write.from.length > 0) {
                    const fromAbs = path.isAbsolute(write.from)
                        ? path.resolve(write.from)
                        : (sandbox ? path.resolve(sandbox, write.from) : null);
                    if (!fromAbs) {
                        send(res, 400, 'write.from is relative but no sandbox was provided: ' + rel);
                        return;
                    }
                    if (sandbox && !pathIsInside(fromAbs, sandbox)) {
                        send(res, 400, 'write.from escapes sandbox: ' + rel);
                        return;
                    }
                    if (!fs.existsSync(fromAbs)) {
                        send(res, 400, 'write.from does not exist: ' + rel);
                        return;
                    }
                    planned.push({ rel, toAbs, kind: 'copy', fromAbs });
                } else {
                    send(res, 400, 'write must include either `content` or `from`: ' + rel);
                    return;
                }
            }

            const applied = [];
            try {
                for (const write of planned) {
                    fs.mkdirSync(path.dirname(write.toAbs), { recursive: true });
                    if (write.kind === 'inline') {
                        // String content writes raw (for plain-text files like
                        // feature-requirements.txt, feature-requirements.txt).
                        // Anything else is JSON-encodable structured data and
                        // gets pretty-printed (canvas/component state.json,
                        // view.json, index.json, etc.).
                        const body = typeof write.content === 'string'
                            ? write.content
                            : JSON.stringify(write.content, null, 2) + '\n';
                        fs.writeFileSync(write.toAbs, body);
                    } else {
                        fs.copyFileSync(write.fromAbs, write.toAbs);
                    }
                    applied.push(write.rel);
                }
            } catch (error) {
                logServer('workspace', 'writes failed mid-batch', { error: error.message, applied });
                send(res, 500, 'write failed after ' + applied.length + ' of ' + planned.length + ': ' + error.message);
                return;
            }
            // No explicit broadcast: the workspace watcher sees these writes —
            // it coalesces the batch into one workspace-file event per file
            // plus a single graph refresh — so the client gets one coherent
            // update without this endpoint announcing anything itself.
            logServer('workspace', 'writes complete', { files: applied });
            send(res, 200, JSON.stringify({ applied }), 'application/json; charset=utf-8');
            return;
        }


        // The canvas's own module (presentation, input controls — anything
        // canvas-scoped) is just <canvas>/canvas.js, served through the generic
        // GET /workspace/<canvas>/canvas.js path the client builds in loadCanvas.
        // No dedicated endpoint: canvas.js imports are root-absolute (/lib/...),
        // so the module's URL base doesn't change resolution.

        const componentFeatures = url.pathname.match(/^\/component\/(.+)\/features$/);

        if (componentFeatures) {
            const componentPath = decodeURIComponent(componentFeatures[1]);
            const entry = canvasGraph.findLeafComponentByPath(componentPath);

            if (!entry) {
                send(res, 404, 'Component not found');
                return;
            }

            if (req.method === 'GET') {
                const { present, text, error } = readComponentFeatures(entry.componentPath);
                send(res, 200, JSON.stringify({
                    text,
                    title: readComponentFeatureTitle(entry.componentPath),
                    present,
                    error
                }), 'application/json; charset=utf-8');
                return;
            }

            if (req.method === 'POST') {
                const body = JSON.parse(await readBody(req));
                const before = readComponentFeatureText(entry.componentPath);
                const after = String(body.text || '');
                const changed = before !== after;

                if (changed) {
                    writeComponentFeatureText(entry.componentPath, after);
                    await appendInternalOutputJob({
                        scope: canvasGraph.componentScope(entry.componentPath),
                        prompt: componentFeaturePrompt({
                            componentScope: canvasGraph.componentScopePath(entry.componentPath),
                            before,
                            after
                        })
                    });
                }

                send(res, 200, JSON.stringify({ changed }), 'application/json; charset=utf-8');
                return;
            }
        }

        const componentResource = url.pathname.match(/^\/component\/(.+)\/resources\/(.+)$/);

        if (req.method === 'GET' && componentResource) {
            const componentPath = decodeURIComponent(componentResource[1]);
            const component = canvasGraph.findAnyByPath(componentPath)?.component;
            const name = decodeURIComponent(componentResource[2]);
            const resource = component && canvasGraph.componentResources(resolveCanvasReference(componentPath), component)[name];

            if (!resource?.path) {
                send(res, 404, 'Component resource not found');
                return;
            }

            streamCanvasFile(req, res, resource.path, resource.mime || resource.type);
            return;
        }

        const file = staticPath(url.pathname);

        if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            send(res, 404, 'Not found');
            return;
        }

        // MIME by extension. Browsers require text/javascript for ES module
        // imports (e.g. /lib/css-layout.js imported from a presentation).
        const ext = path.extname(file).toLowerCase();
        const mime = {
            '.html': 'text/html; charset=utf-8',
            '.js':   'text/javascript; charset=utf-8',
            '.mjs':  'text/javascript; charset=utf-8',
            '.css':  'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8'
        }[ext];

        streamFile(req, res, file, mime);
    } catch (error) {
        logHermesError('request', error, { message: 'request error' });
        send(res, error.statusCode || 500, 'Error: ' + error.message);
    }
});

setCanvasPath(CANVAS_PATH);
startWorkspaceWatch();

const commitShutdownState = reason => {
    if (shutdownCommitAttempted) {
        return false;
    }

    shutdownCommitAttempted = true;
    return activityPersistence.persistActivity({
        event: activeOutputJob && activeOutputJob.event ? activeOutputJob.event : (activeOutputJob && activeOutputJob.activityRecord ? activeOutputJob.activityRecord.event : null),
        scope: activeOutputJob && activeOutputJob.scope ? activeOutputJob.scope : (activeOutputJob && activeOutputJob.activityRecord ? activeOutputJob.activityRecord.scope : CANVAS_PATH),
        prompt: activeOutputJob && activeOutputJob.prompt ? activeOutputJob.prompt : (activeOutputJob && activeOutputJob.activityRecord ? activeOutputJob.activityRecord.prompt : '(no active prompt)'),
        agentResponse: activeOutputJob && activeOutputJob.activityRecord
            ? (activeOutputJob.activityRecord.rawAgentResponse || activeOutputJob.activityRecord.persistedAgentResponse || '')
            : '',
        mode: 'shutdown',
        reason
    });
};

const shutdownCanvasRuntime = reason => {
    commitShutdownState(reason || 'application was shut down');
    stopWorkspaceWatch();

    if (networkManagerPromise) {
        // Fire-and-forget — shutdown is synchronous from this caller's
        // perspective and we don't want the libp2p stop hanging the exit.
        networkManagerPromise.then(net => net.stop()).catch(() => {});
    }

    if (activeCanvasRuntime) {
        activeCanvasRuntime.stop();
        activeCanvasRuntime = null;
        return true;
    }

    return false;
};

process.on('exit', () => shutdownCanvasRuntime('process exit'));
process.on('SIGINT', () => {
    shutdownCanvasRuntime('SIGINT');
    process.exit(130);
});
process.on('SIGTERM', () => {
    shutdownCanvasRuntime('SIGTERM');
    process.exit(143);
});
// On the way down from a crash, leave a marker (the error and stack) for the
// next boot. The app restarts the server, and that boot hands the marker to the
// agent (Phase 1, make it bootable). See canvas/crash-recovery.js.
const recordCrash = (kind, error) => {
    crashRecovery.writeCrashReport(WORKSPACE_PATH, {
        reason: kind + ': ' + (error && error.message ? error.message : String(error)),
        stack: error && error.stack ? error.stack : ''
    });
};
// EPIPE means a write failed because the reader of our stdout/stderr went away —
// in practice the app being force-quit, which gets an uncatchable SIGKILL and so
// never stops us cleanly. The orphaned server's next write (a service forwarding
// output, a log line) then throws EPIPE. That is not a workspace crash, so don't
// leave a marker, or the next launch boots into a phantom recovery.
const isBrokenOutputPipe = error => error && error.code === 'EPIPE';
process.on('uncaughtException', error => {
    logHermesError('crash', error, { message: 'uncaught exception' });
    if (!isBrokenOutputPipe(error)) recordCrash('uncaught exception', error);
    shutdownCanvasRuntime('uncaught exception: ' + error.message);
    process.exit(1);
});
process.on('unhandledRejection', reason => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logHermesError('crash', error, { message: 'unhandled rejection' });
    if (!isBrokenOutputPipe(error)) recordCrash('unhandled rejection', error);
    shutdownCanvasRuntime('unhandled rejection: ' + error.message);
    process.exit(1);
});

// The network manager owns the libp2p lifecycle and the opt-in/lazy-start
// policy (see canvas/network.mjs createNetworkManager). network.mjs is ESM, so
// from this CommonJS file we reach the manager through one lazy dynamic import.
// That import is cheap and does NOT start the node — only manager.ensure()
// does — so an idle, non-sharing workspace never joins the public DHT.
let networkManagerPromise = null;
const network = () => {
    if (!networkManagerPromise) {
        networkManagerPromise = import('./canvas/network.mjs')
            .then(module => module.createNetworkManager({ workspacePath: WORKSPACE_PATH }))
            .catch(error => {
                console.error('Network: failed to load', error?.message || error);
                networkManagerPromise = null;  // let the next action retry the load
                // A no-op manager keeps callers safe (status reports not
                // running, ensure is a no-op) when the module can't load —
                // the harness keeps running, just without networking.
                return {
                    ensure: () => Promise.resolve(null),
                    status: () => ({ running: false }),
                    shouldAutoStart: () => false,
                    peerFeed: () => null,
                    node: () => null,
                    stop: () => Promise.resolve()
                };
            });
    }
    return networkManagerPromise;
};

// Clean up any workers a prior server for this workspace left behind (crash /
// SIGKILL / force-quit) before we start spawning our own.
newShapeReapStrayWorkspaceProcesses();

server.listen(PORT, '127.0.0.1', () => {
    const address = server.address();
    const resolvedPort = address && typeof address === 'object' ? address.port : PORT;

    console.log('Build: ' + SERVER_BUILD);
    console.log('Server at http://127.0.0.1:' + resolvedPort);
    console.log('Canvas: ' + CANVAS_PATH);
    console.log('Input: ' + INDEX_PATH);

    // The workspace booted. If a crash left work owed, dispatch it: Phase 1
    // (make it bootable) when a crash marker is present, otherwise Phase 2 (the
    // permanent fix) when a recovery still owes one. The agent does the work;
    // the server just dispatches.
    dispatchCrashRecovery();

    // Tell the app where we stand: hold the recovery screen while Phase 1 makes
    // the workspace bootable, otherwise it's ready for the canvas. (Phase 2, if
    // owed, runs in the background and doesn't hold the canvas back.)
    emitRecoveryState(recovering ? 'recovering' : 'ready');

    // Networking is opt-in; the policy lives in the manager. Auto-start the
    // node only when this workspace already shares something (so peers can
    // reach it); otherwise it stays down until a networking action lazily
    // starts it. Don't await — HTTP serves immediately.
    network().then(net => { if (net.shouldAutoStart()) net.ensure(); });
});
