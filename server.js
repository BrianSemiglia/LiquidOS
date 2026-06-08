const http = require('http');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createActivityPersistence } = require('./canvas/activity-persistence');
const { createRuntimes } = require('./agent/(workspacePath+runtimePath+skillsPath)->runtimes');
const { createActiveRuntime } = require('./agent/(runtimes+selection)->active-runtime');
const { createCanvasFiles } = require('./canvas/files');
const { createCanvasGraph } = require('./canvas/graph');
const { createOutputQueue } = require('./canvas/output-queue');
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
    'prompt-bar-test', 'install-build-test', 'cross-canvas-persistence-test']);

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
const ACTIVE_CANVAS_FILE = path.join(WORKSPACE_PATH, 'active-canvas.json');
const ACTIVE_AGENT_FILE = path.join(WORKSPACE_PATH, 'active-agent.json');
const DEFAULT_CANVAS_NAME = 'home';
const DEFAULT_CANVAS_PATH = path.join(WORKSPACE_PATH, DEFAULT_CANVAS_NAME);

const validCanvasName = value =>
    typeof value === 'string'
        && value.trim() === value
        && /^[^/][^/]*$/.test(value)
        && !value.startsWith('.')
        && !value.includes('..');

const activeCanvasNameFromFile = () => {
    try {
        if (!fs.existsSync(ACTIVE_CANVAS_FILE)) return DEFAULT_CANVAS_NAME;
        const value = JSON.parse(fs.readFileSync(ACTIVE_CANVAS_FILE, 'utf8'));
        return validCanvasName(value?.canvas) ? value.canvas : DEFAULT_CANVAS_NAME;
    } catch {
        return DEFAULT_CANVAS_NAME;
    }
};

const writeActiveCanvasName = name => {
    fs.writeFileSync(
        ACTIVE_CANVAS_FILE,
        JSON.stringify({ canvas: validCanvasName(name) ? name : DEFAULT_CANVAS_NAME }, null, 2) + '\n'
    );
};

const validAgentKind = value =>
    typeof value === 'string'
        && VALID_AGENT_KINDS.has(value.trim().toLowerCase());

const activeAgentKindFromFile = () => {
    try {
        if (!fs.existsSync(ACTIVE_AGENT_FILE)) return DEFAULT_AGENT_KIND;
        const value = JSON.parse(fs.readFileSync(ACTIVE_AGENT_FILE, 'utf8'));
        return validAgentKind(value?.agent) ? value.agent.trim().toLowerCase() : DEFAULT_AGENT_KIND;
    } catch {
        return DEFAULT_AGENT_KIND;
    }
};

const writeActiveAgentKind = kind => {
    fs.writeFileSync(
        ACTIVE_AGENT_FILE,
        JSON.stringify({ agent: validAgentKind(kind) ? String(kind).trim().toLowerCase() : DEFAULT_AGENT_KIND }, null, 2) + '\n'
    );
};

const canvasNameFromPath = canvasPath =>
    path.relative(WORKSPACE_PATH, canvasPath) || path.basename(canvasPath);

let CANVAS_PATH = path.join(WORKSPACE_PATH, activeCanvasNameFromFile());
let INPUT_PATH = path.join(CANVAS_PATH, 'input.json');
let ACTIVE_AGENT_KIND = activeAgentKindFromFile();
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

if (!fs.existsSync(path.join(CANVAS_PATH, 'input.json'))) {
    CANVAS_PATH = DEFAULT_CANVAS_PATH;
    INPUT_PATH = path.join(CANVAS_PATH, 'input.json');
    writeActiveCanvasName(DEFAULT_CANVAS_NAME);
}

if (!fs.existsSync(ACTIVE_AGENT_FILE)) {
    writeActiveAgentKind(ACTIVE_AGENT_KIND);
}
runtimeSet.refreshRuntime();
const PORT = Number.parseInt(requiredArg('--port'), 10);

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
    failStartup('--port must be an integer from 0 to 65535');
}
const AGENT_SOURCE = 'agent';
const clients = new Set();
const debugClients = new Set();

const emitDebugEvent = payload => {
    const message = JSON.stringify(payload);
    debugClients.forEach(res => {
        res.write('event: ' + payload.type + '\n');
        res.write('data: ' + message + '\n\n');
    });
};
let watchers = [];
let workspaceWatcher = null;
let dirtyWatchEntries = [];
let graphWatchStarted = false;
let graphWatchKey = '';
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
    agentDebugState.current = {
        ...next,
        source: next.source || AGENT_SOURCE,
        at: new Date().toISOString()
    };

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

const stripAnsiForLog = value =>
    String(value || '')
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
        .replace(/\r/g, '');

const writeProcessOutput = (label, chunk, stream = process.stdout) => {
    String(chunk || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split(/(?<=\n)/)
        .forEach(line => {
            if (!line.length) {
                return;
            }

            const cleanLine = stripAnsiForLog(line);

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
    output: writeProcessOutput,
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
    getInputPath: () => INPUT_PATH,
    readJson,
    resolveCanvasReference
});

canvasFiles.ensureCanvasDefaults('home');

const ensureActiveCanvasFiles = () => {
    if (!fs.existsSync(INPUT_PATH)) {
        throw new Error('Canvas input.json not found: ' + INPUT_PATH);
    }
};

const applyCanvasRuntime = runtime => {
    CANVAS_PATH = runtime.canvasPath;
    INPUT_PATH = runtime.inputPath;
    return runtime;
};

const createCanvasRuntime = canvasPath => {
    const resolvedCanvasPath = resolveConfigPath(canvasPath);

    return {
        canvasPath: resolvedCanvasPath,
        inputPath: path.join(resolvedCanvasPath, 'input.json'),
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

            dirtyWatchEntries = [];
if (workspaceWatcher) {
    workspaceWatcher.close();
    workspaceWatcher = null;
}
            watchers.forEach(watcher => watcher.close());
            watchers = [];
            graphWatchStarted = false;
            graphWatchKey = '';
            outputQueue.clearActiveLanes();
            this.started = false;
            return this;
        }
    };
};

const setCanvasPath = canvasPath => {
    const nextCanvasPath = resolveConfigPath(canvasPath);

    if (activeCanvasRuntime && activeCanvasRuntime.canvasPath === nextCanvasPath) {
        activeCanvasRuntime.start();
        writeActiveCanvasName(canvasNameFromPath(nextCanvasPath));
        return activeCanvasRuntime;
    }

    if (activeCanvasRuntime) {
        activeCanvasRuntime.stop();
    }

    activeCanvasRuntime = createCanvasRuntime(nextCanvasPath);
    activeCanvasRuntime.start();
    writeActiveCanvasName(canvasNameFromPath(nextCanvasPath));
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

const buildAgentPrompt = job => {
    const prompt = promptBuilder.buildJobPrompt(job);

    return activeRuntime.preparePrompt(prompt);
};

const runQueuedAgentJob = (prompt, context = {}) => {
    return activeRuntime.run(prompt, context);
};

let activeOutputJob = null;
let shutdownCommitAttempted = false;

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
            inputPath: path.join(jobCanvasPath, 'input.json'),
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
            title: 'Agent finished',
            body: canvasName(jobCanvasPath)
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
            title: 'Agent failed',
            body: canvasName(jobCanvasPath)
        });

    } finally {
        if (activeOutputJob && activeOutputJob.id === jobId) {
            activeOutputJob = null;
        }
    }
};

outputQueue.setProcessJob(processOutputJob);

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

const componentChangePayload = (entries, rendered) => {
    if (entries.length === 0) return null;
    if (!rendered || rendered.canvasError) return null;

    // When only component watch entries fired (an edit anywhere inside a
    // component's folder), ship the affected components in a typed event so
    // the client can update them without a full reload.
    const componentKinds = new Set(['component', 'relationship']);
    if (entries.every(entry => componentKinds.has(entry.kind)) && Array.isArray(rendered.components)) {
        const dirtyFolders = new Set(entries.map(entry => entry.componentPath));
        const components = rendered.components.filter(component =>
            dirtyFolders.has(canvasGraph.componentFolderPath(component.componentPath)));

        if (components.length === 0) return null;
        return { type: 'components-changed', components };
    }

    // Everything else (canvas.js, or any mix) emits a generic update;
    // the client falls through to load() which is cheap enough (existing
    // DOM is reused) that a separate fast path isn't worth the API surface.
    return null;
};

// When the apply endpoint is mid-flight, the watcher pipeline pauses:
// fs.watch events for files we just wrote are dropped instead of being
// rebroadcast. After the apply completes the server emits one explicit
// refresh, so the client sees a single coherent change instead of one
// event per copied file.
let watcherPaused = false;

const scheduleWatchRefresh = entry => {
    if (watcherPaused) return;
    if (entry) {
        dirtyWatchEntries.push(entry);
    }

    const entries = dirtyWatchEntries;
    dirtyWatchEntries = [];

    let rendered;

    try {
        rendered = canvasGraph.renderedInput();
        refreshGraphWatchers();
    } catch (error) {
        logHermesError('watch', error, { message: 'watch error' });
        broadcast();
        return;
    }

    broadcast(componentChangePayload(entries, rendered));
};

const broadcastWorkspaceFile = (watchedDir, filename) => {
    if (watcherPaused) return;
    if (!filename) return;
    const abs = path.join(watchedDir, filename);
    const rel = path.relative(WORKSPACE_PATH, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    broadcast({ type: 'workspace-file', path: rel });
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

// active-canvas.json is the source of truth for the active canvas. POST
// /canvas writes it; agents and external editors may also write it
// directly. In every case the workspace watcher detects the change,
// diffs the file against in-memory state, and applies. POST stays fast
// because it updates in-memory state inline; the watcher path is the
// catch-up for everyone else.
const applyActiveCanvasFromFile = () => {
    const name = activeCanvasNameFromFile();
    const desiredPath = path.join(WORKSPACE_PATH, name);
    if (CANVAS_PATH === desiredPath) return;
    try {
        canvasFiles.switchCanvas(name);
    } catch (error) {
        logHermesError('active-canvas', error, {
            message: 'active-canvas.json points at missing or invalid canvas: ' + name
        });
        return;
    }
    broadcast({ type: 'canvases-changed' });
    broadcast();
};

const scheduleWorkspaceRefresh = (eventType, filename) => {
    // Do not close-and-recreate the watcher here. fs.watch's earlier
    // behavior (recreating on every event) caused the in-process writes
    // from /canvas and similar endpoints to be dropped on macOS — the
    // close/open cycle raced with FSEvents and ate same-process events.
    // A single long-lived watcher on the workspace root is enough:
    // FSEvents and inotify both observe the directory itself, so new
    // canvases that appear under it still fire events.
    if (filename === 'active-canvas.json') {
        applyActiveCanvasFromFile();
        return;
    }
    if (!isCanvasCandidateFilename(filename)) return;
    broadcastWorkspaceFile(WORKSPACE_PATH, filename);
    broadcast({ type: 'canvases-changed' });
};

const watchWorkspace = () => {
    if (workspaceWatcher) {
        workspaceWatcher.close();
        workspaceWatcher = null;
    }

    workspaceWatcher = fs.watch(WORKSPACE_PATH, { persistent: false }, scheduleWorkspaceRefresh);
};

const safeWatchEntries = () => {
    try {
        return canvasGraph.watchedPaths()
            .filter(entry => fs.existsSync(entry.path))
            .filter(entry => {
                try {
                    return path.relative(CANVAS_PATH, entry.path) === ''
                        || (!path.relative(CANVAS_PATH, entry.path).startsWith('..') && !path.isAbsolute(path.relative(CANVAS_PATH, entry.path)));
                } catch (error) {
                    return false;
                }
            });
    } catch (error) {
        logHermesError('watch', error, {
            message: 'graph watch paused until canvas config is repaired'
        });
        return fs.existsSync(INPUT_PATH)
            ? [{ path: INPUT_PATH, recursive: false, kind: 'canvas' }]
            : [];
    }
};

const refreshGraphWatchers = () => {
    const entries = safeWatchEntries();
    const nextKey = JSON.stringify(entries.map(entry => [entry.path, Boolean(entry.recursive)]).sort());

    if (nextKey === graphWatchKey) {
        return;
    }

    watchers.forEach(watcher => watcher.close());
    watchers = [];
    graphWatchKey = nextKey;

    entries.forEach(entry => {
        try {
            watchers.push(fs.watch(entry.path, { persistent: false, recursive: Boolean(entry.recursive) }, (eventType, filename) => {
                broadcastWorkspaceFile(entry.path, filename);

                // The canvas-root watch covers canvas.js (presentation reload).
                if (entry.kind === 'canvas-root' && filename) {
                    if (filename === 'canvas.js') {
                        scheduleWatchRefresh({ ...entry, kind: 'canvas-js' });
                    }
                    return;
                }

                if (entry.kind === 'component' || entry.kind === 'relationship') {
                    if (!filename) return;
                    // Diagnostics is owned by its writers: error-router.js
                    // sets runtime ok:false on a thrown error, and clears
                    // ok:true once a re-mount stays quiet (see
                    // noteSuccessfulMount). The harness must not infer
                    // diagnostic state from filesystem events.
                    scheduleWatchRefresh(entry);
                    return;
                }

                scheduleWatchRefresh(entry);
            }));
        } catch (error) {
            logHermesError('watch', error, { file: entry.path, message: 'file watch skipped' });
        }
    });
};

const watchGraph = () => {
    graphWatchStarted = true;
    refreshGraphWatchers();
};

const startGraphWatchAfterFirstInput = () => {
    if (!graphWatchStarted) {
        setImmediate(watchGraph);
    }
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

const appendInternalOutputJob = async ({ scope, prompt }) => {
    await outputQueue.appendOutputJob({
        id: 'output-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        scope,
        status: 'pending',
        createdAt: new Date().toISOString(),
        componentKey: scope,
        prompt
    });
    outputQueue.feedHermesOutput();
    broadcastQueueState();
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
    'Keep feature-requirements.txt user-facing, concise, plain-language, and faithful to what the component does or is meant to do. It is a plain text file with no title — the title comes from view.json.',
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
    '- Add, remove, or modify components in input.json as the prose dictates.',
    '- Add, remove, or modify relationships under ' + canvasScope + '/relationships/ (see skills/relationships).',
    '- Update individual components\' feature-requirements.txt files when canvas-level intent changes their roles.',
    'Keep feature-requirements.txt user-facing, plain-language, and faithful to what the canvas is for.',
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

const newShapeKillService = (id) => {
    const svc = newShapeServices.get(id);
    if (!svc) return false;
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
    const allPids = [];
    for (const svc of newShapeServices.values()) {
        const root = svc.child.pid;
        allPids.push(root, ...newShapeDescendantsOf(root));
    }
    for (const pid of allPids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    process.exit(code);
};
process.on('SIGINT', () => newShapeShutdown(0));
process.on('SIGTERM', () => newShapeShutdown(0));

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
            newShapeServices.set(id, { child, label: body.label || path.basename(abs), dispatchId, abs });
            child.stdout.on('data', d => process.stdout.write('[' + id + '] ' + d.toString().replace(/\n$/, '') + '\n'));
            child.stderr.on('data', d => process.stderr.write('[' + id + '] ' + d.toString().replace(/\n$/, '') + '\n'));
            child.on('exit', () => newShapeServices.delete(id));
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


        if (req.method === 'GET' && url.pathname === '/debug/agent/stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });
            debugClients.add(res);
            res.write('event: debug-ready\n');
            res.write('data: {"type":"debug-ready"}\n\n');
            res.write('event: debug-snapshot\n');
            res.write('data: ' + JSON.stringify({ type: 'debug-snapshot', snapshot: currentAgentDebugSnapshot() }) + '\n\n');
            req.on('close', () => debugClients.delete(res));
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
                if (peerFeedCache) {
                    for (const [, entry] of peerFeedCache.cache) {
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
                    if (!networkNode || !networkModule || !peerFeedCache) {
                        send(res, 503, 'network not running'); return;
                    }
                    for (const [pid, peerEntry] of peerFeedCache.cache) {
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
            const status = networkModule && networkNode
                ? networkModule.statusOf(networkNode)
                : { running: false };
            send(res, 200, JSON.stringify(status), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/network/dial') {
            // Manually dial a peer by multiaddr. Mostly a debug / test
            // affordance: in production, peers find each other through
            // the libp2p DHT bootstrap, but in tests with two local
            // nodes we want a direct connection without waiting on the
            // public DHT to route us together.
            if (!networkNode || !networkModule) { send(res, 503, 'network not running'); return; }
            let body;
            try { body = JSON.parse(await readBody(req) || '{}'); }
            catch { send(res, 400, 'invalid json'); return; }
            const target = String(body.multiaddr || '').trim();
            if (!target) { send(res, 400, 'multiaddr required'); return; }
            try {
                const { multiaddr } = await import('@multiformats/multiaddr');
                await networkNode.dial(multiaddr(target));
                send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
            } catch (error) {
                send(res, 502, 'dial failed: ' + (error?.message || error));
            }
            return;
        }

        if (req.method === 'POST' && url.pathname === '/agent/select') {
            const body = JSON.parse(await readBody(req));

            const normalized = String(body.kind || '').trim().toLowerCase();
            const result = activeRuntime.select(normalized);

            if (!result.ok) {
                send(res, result.statusCode, JSON.stringify({ error: result.error }), 'application/json; charset=utf-8');
                return;
            }

            ACTIVE_AGENT_KIND = activeRuntime.activeKind() || normalized;
            writeActiveAgentKind(ACTIVE_AGENT_KIND);

            if (outputQueue) {
                outputQueue.feedHermesOutput();
            }

            broadcast({
                type: 'agent-mode',
                agentKind: ACTIVE_AGENT_KIND
            });

            send(res, 200, JSON.stringify({
                ok: true,
                agent: result.agent
            }), 'application/json; charset=utf-8');
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
            startGraphWatchAfterFirstInput();
            return;
        }

        if (req.method === 'GET' && url.pathname === '/canvases') {
            send(res, 200, JSON.stringify({
                current: canvasName(CANVAS_PATH),
                currentPath: CANVAS_PATH,
                canvases: canvasFiles.availableCanvases()
            }), 'application/json; charset=utf-8');
            if (!workspaceWatcher) {
                setImmediate(watchWorkspace);
            }
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

        if (req.method === 'POST' && url.pathname === '/canvas') {
            const body = JSON.parse(await readBody(req));

            canvasFiles.switchCanvas(String(body.name || ''));
            // fs.watch on macOS doesn't reliably fire for the same process's
            // own writes (writeActiveCanvasName just modified the workspace
            // root) — so emit canvases-changed explicitly. Other browser
            // sessions need this to refresh their canvas dropdowns; the
            // generic update below drives the current session's load().
            broadcast({ type: 'canvases-changed' });
            broadcast();
            send(res, 200, JSON.stringify({
                current: canvasName(CANVAS_PATH),
                canvases: canvasFiles.availableCanvases()
            }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/canvases') {
            const body = JSON.parse(await readBody(req));
            const name = canvasFiles.createCanvas(body.name);

            canvasFiles.switchCanvas(name);
            activityPersistence.persistActivity({
                event: `User did create canvas with name '${String(name).replace(/[\n\r]+/g, ' ').replace(/'/g, "\\'")}'`,
                scope: CANVAS_PATH,
                prompt: '',
                agentResponse: 'none',
                mode: 'done'
            });
            // Same reasoning as /canvas above — fs.watch may miss the
            // in-process directory mutation, so emit canvases-changed
            // explicitly.
            broadcast({ type: 'canvases-changed' });
            broadcast();
            send(res, 201, JSON.stringify({
                current: canvasName(CANVAS_PATH),
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

            watcherPaused = true;
            const applied = [];
            try {
                for (const write of planned) {
                    fs.mkdirSync(path.dirname(write.toAbs), { recursive: true });
                    if (write.kind === 'inline') {
                        // String content writes raw (for plain-text files like
                        // feature-requirements.txt, feature-requirements.txt).
                        // Anything else is JSON-encodable structured data and
                        // gets pretty-printed (canvas/component state.json,
                        // view.json, input.json, etc.).
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
                watcherPaused = false;
                dirtyWatchEntries = [];
                logServer('workspace', 'writes failed mid-batch', { error: error.message, applied });
                send(res, 500, 'write failed after ' + applied.length + ' of ' + planned.length + ': ' + error.message);
                scheduleWatchRefresh();
                return;
            }
            watcherPaused = false;
            dirtyWatchEntries = [];

            // One explicit refresh: re-read workspace, broadcast generic
            // update so the client runs load() once for the entire batch.
            try {
                canvasGraph.renderedInput();
                refreshGraphWatchers();
            } catch (error) {
                logHermesError('writes', error, { message: 'post-writes refresh failed' });
            }
            // External listeners (canvas.js, services) see one workspace-file
            // event per applied path so they can re-fetch a coherent end-of-
            // batch state instead of intermediate writes mid-flight.
            applied.forEach(rel => broadcast({ type: 'workspace-file', path: rel }));
            broadcast();
            logServer('workspace', 'writes complete', { files: applied });
            send(res, 200, JSON.stringify({ applied }), 'application/json; charset=utf-8');
            return;
        }


        // The canvas's own module — presentation, input controls, anything
        // canvas-scoped. Always served from <canvas>/canvas.js. CSS-only
        // canvases import the cssLayout helper from /lib/ and delegate.
        if (req.method === 'GET' && url.pathname === '/canvas.js') {
            const resolvedPath = canvasGraph.canvasJsPath();
            if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
                send(res, 404, 'canvas.js not found');
                return;
            }
            streamFile(req, res, resolvedPath, 'text/javascript; charset=utf-8');
            return;
        }


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
watchWorkspace();

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

    if (networkNode && networkModule) {
        // Fire-and-forget — shutdown is synchronous from this caller's
        // perspective and we don't want the libp2p stop hanging the exit.
        networkModule.stopNetworkNode(networkNode).catch(() => {});
        networkNode = null;
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
process.on('uncaughtException', error => {
    logHermesError('crash', error, { message: 'uncaught exception' });
    shutdownCanvasRuntime('uncaught exception: ' + error.message);
    process.exit(1);
});
process.on('unhandledRejection', reason => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logHermesError('crash', error, { message: 'unhandled rejection' });
    shutdownCanvasRuntime('unhandled rejection: ' + error.message);
    process.exit(1);
});

// libp2p node — created on harness boot, exposed at /network/status. The
// module is ESM so we load it via dynamic import. Stays null if startup
// fails so the harness keeps running even when the network is broken.
let networkNode = null;
let networkModule = null;
// Per-peer feed cache: Map<peerId, { peerId, multiaddrs, feed, refreshedAt }>
// plus a stop() for shutdown.
let peerFeedCache = null;
const startNetwork = async () => {
    try {
        networkModule = await import('./canvas/network.mjs');
        networkNode = await networkModule.createNetworkNode({
            identityPath: path.join(WORKSPACE_PATH, '.network', 'identity.bin')
        });
        networkModule.registerShareProtocols(
            networkNode,
            path.join(WORKSPACE_PATH, '.share'),
            WORKSPACE_PATH
        );
        peerFeedCache = await networkModule.startPeerFeedCache(
            networkNode,
            WORKSPACE_PATH
        );
        console.log('Network: peer ID', networkNode.peerId.toString());
        for (const addr of networkNode.getMultiaddrs()) {
            console.log('Network: listening on', addr.toString());
        }
    } catch (error) {
        console.error('Network: failed to start', error?.message || error);
    }
};

server.listen(PORT, '127.0.0.1', () => {
    const address = server.address();
    const resolvedPort = address && typeof address === 'object' ? address.port : PORT;

    console.log('Build: ' + SERVER_BUILD);
    console.log('Server at http://127.0.0.1:' + resolvedPort);
    console.log('Canvas: ' + CANVAS_PATH);
    console.log('Input: ' + INPUT_PATH);

    // Kick off the libp2p node in the background. Don't await — the
    // harness should serve HTTP immediately even if bootstrap to the
    // DHT takes seconds (which it usually does).
    startNetwork();
});
