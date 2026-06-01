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
const { syncSkills } = require('./workspace/sync-skills');
const { runMigration } = require('./workspace/run-migration');

const WORKSPACE_FIX_MARKER_REL = path.join('.liquidos', 'workspace-error');

const ROOT = __dirname;
const SERVER_BUILD = 'hermes-output-server-2026-05-10-canvases-git-timeline';

const VALID_AGENT_KINDS = new Set(['codex', 'claude-code', 'hermes', 'pi', 'none']);

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

const WORKSPACE_PATH = resolveConfigPath(requiredArg('--workspace'));
const DEFAULT_AGENT_KIND = String(requiredArg('--agent')).trim().toLowerCase();

if (!VALID_AGENT_KINDS.has(DEFAULT_AGENT_KIND)) {
    failStartup('Invalid --agent. Expected one of: codex, claude-code, hermes, pi');
}

const optionalArg = (name, fallback) =>
    REQUIRED_ARGUMENTS.has(name) ? REQUIRED_ARGUMENTS.get(name) : fallback;

if (path.extname(WORKSPACE_PATH) !== '.liquidos') {
    failStartup('--workspace must be a .liquidos folder');
}

if (!fs.existsSync(WORKSPACE_PATH) || !fs.statSync(WORKSPACE_PATH).isDirectory()) {
    failStartup('--workspace does not exist or is not a folder: ' + WORKSPACE_PATH);
}

const CANVAS_TEMPLATE_ROOT = path.join(ROOT, 'skills', 'canvas-creator', 'templates');
const ACTIVE_CANVAS_FILE = path.join(WORKSPACE_PATH, 'active-canvas.json');
const ACTIVE_AGENT_FILE = path.join(WORKSPACE_PATH, 'active-agent.json');
const LEGACY_SELECTED_CANVAS_FILE = path.join(WORKSPACE_PATH, 'selected-canvas.json');
const LEGACY_SELECTED_AGENT_FILE = path.join(WORKSPACE_PATH, 'selected-agent.json');
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
        const file = fs.existsSync(ACTIVE_CANVAS_FILE) ? ACTIVE_CANVAS_FILE : LEGACY_SELECTED_CANVAS_FILE;

        if (!fs.existsSync(file)) {
            return DEFAULT_CANVAS_NAME;
        }

        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        const name = typeof value === 'string' ? value : value.canvas;
        return validCanvasName(name) ? name : DEFAULT_CANVAS_NAME;
    } catch (error) {
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
        const file = fs.existsSync(ACTIVE_AGENT_FILE) ? ACTIVE_AGENT_FILE : LEGACY_SELECTED_AGENT_FILE;

        if (!fs.existsSync(file)) {
            return DEFAULT_AGENT_KIND;
        }

        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        const candidate = typeof value === 'string'
            ? value
            : value?.agent ?? value?.kind ?? value?.selectedAgentKind;

        return validAgentKind(candidate) ? candidate.trim().toLowerCase() : DEFAULT_AGENT_KIND;
    } catch (error) {
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
let OUTPUT_PATH = path.join(CANVAS_PATH, 'output.json');
let ACTIVE_AGENT_KIND = activeAgentKindFromFile();
const AGENT_RUNTIME_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'LiquidOS', 'AgentRuntime');
const SKILLS_SOURCE_PATH = path.join(ROOT, 'skills');

// Skill sync runs before anything else touches the workspace. It ensures the
// workspace is a git repo, refreshes <workspace>/skills/ from the runtime,
// and commits any delta. A delta drops a marker file (.liquidos/migration-
// pending) downstream code can act on. Failures don't abort startup — the
// runtime should still come up so the user can recover.
const SKILLS_SYNC = syncSkills({
    workspacePath: WORKSPACE_PATH,
    skillsSourcePath: SKILLS_SOURCE_PATH
});
if (SKILLS_SYNC.error) {
    console.warn('[skills-sync] failed:', SKILLS_SYNC.error);
} else {
    if (SKILLS_SYNC.initialized) console.log('[skills-sync] initialized workspace git');
    if (SKILLS_SYNC.updated) {
        console.log('[skills-sync] committed', SKILLS_SYNC.sha?.slice(0, 8),
            '(parent', SKILLS_SYNC.parentSha?.slice(0, 8) || 'none', ')');
    }
}

// Tracks the lifecycle of the current/last workspace-fix run. /input
// exposes this so the client can show a loading state and the user can see
// why the canvas is unresponsive. lastError persists across the run so a
// user looking at the workspace after a failed startup knows what went
// wrong.
const MIGRATION_STATE = {
    running: false,
    lastError: null
};
const isMigrationPending = () => fs.existsSync(path.join(WORKSPACE_PATH, WORKSPACE_FIX_MARKER_REL));

// Catch-all detector for workspace-scope problems. Wraps each top-level
// invariant in its own try/catch so a failure in one area doesn't suppress
// detection of others. Returns an array of { check, error } objects; an
// empty array means the workspace's top-level state looks healthy. Canvas-
// and component-level errors are intentionally NOT included here — those
// surface through the existing repair-card flows and are handled by per-
// canvas / per-component agents, not by this workspace-wide fix step.
const collectWorkspaceErrors = () => {
    const errors = [];
    const check = (name, fn) => {
        try { fn(); }
        catch (error) { errors.push({ check: name, error: error.message }); }
    };

    check('active-canvas-resolves', () => {
        const name = activeCanvasNameFromFile();
        if (!name) throw new Error('no active canvas configured');
        const folder = path.join(WORKSPACE_PATH, name);
        if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
            throw new Error(`active canvas folder is missing: ${name}`);
        }
    });

    check('active-agent-valid', () => {
        const kind = activeAgentKindFromFile();
        if (!VALID_AGENT_KINDS.has(kind)) {
            throw new Error(`unknown agent kind in active-agent.json: ${kind}`);
        }
    });

    check('workspace-has-canvases', () => {
        const list = canvasFiles.availableCanvases();
        if (!Array.isArray(list) || list.length === 0) {
            throw new Error('workspace has no canvases');
        }
    });

    return errors;
};

const writeWorkspaceFixMarker = (errors, context = {}) => {
    const markerPath = path.join(WORKSPACE_PATH, WORKSPACE_FIX_MARKER_REL);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const body = {
        detectedAt: new Date().toISOString(),
        errors,
        ...context
    };
    fs.writeFileSync(markerPath, JSON.stringify(body, null, 2) + '\n');
};

// Agent runtimes that fail mid-run can return the entire captured stdout
// (often a 5-10KB JSON stream) as the error string. Trim it down to
// something a human can read in an overlay; the full output is still in
// the agent runtime's own log.
const summarizeMigrationError = raw => {
    const text = String(raw || '').trim();
    if (!text) return null;
    const firstLine = text.split('\n').find(line => line.trim().length > 0) || text;
    const cleaned = firstLine.replace(/\s+/g, ' ').trim();
    return cleaned.length > 240 ? cleaned.slice(0, 237) + '...' : cleaned;
};

// Single entry point for kicking off a migration. Idempotent: returns
// { ok: false, reason } if there's nothing to do or a run is already in
// flight, so callers don't need to know the state. Used by both startup
// auto-fire and the manual /workspace/retry-migration endpoint.
const dispatchMigration = () => {
    if (MIGRATION_STATE.running) return { ok: false, reason: 'already-running' };
    if (!isMigrationPending()) return { ok: false, reason: 'no-marker' };

    MIGRATION_STATE.running = true;
    MIGRATION_STATE.lastError = null;
    broadcast();

    setImmediate(() => {
        runMigration({
            workspacePath: WORKSPACE_PATH,
            activeRuntime,
            logServer,
            systemPromptPath: AGENTS_RUNTIME_PATH
        })
            .then(result => {
                logServer('migration', 'run complete', result);
                if (result?.error) {
                    MIGRATION_STATE.lastError = summarizeMigrationError(result.error);
                } else if (result?.markerCleared === false) {
                    MIGRATION_STATE.lastError = 'agent returned but did not clear the migration marker';
                } else {
                    MIGRATION_STATE.lastError = null;
                }
            })
            .catch(error => {
                logServer('migration', 'run errored', { error: error.message });
                MIGRATION_STATE.lastError = summarizeMigrationError(error.message);
            })
            .finally(() => {
                MIGRATION_STATE.running = false;
                broadcast();
            });
    });

    return { ok: true };
};

const runtimeSet = createRuntimes({
    workspacePath: WORKSPACE_PATH,
    runtimePath: AGENT_RUNTIME_PATH,
    skillsPath: SKILLS_SOURCE_PATH
});
const activeRuntime = createActiveRuntime({
    runtimes: runtimeSet.runtimes,
    selection: ACTIVE_AGENT_KIND
});
ACTIVE_AGENT_KIND = activeRuntime.activeKind() || ACTIVE_AGENT_KIND;
const AGENT_RUNTIME_LOGS_PATH = runtimeSet.runtimeLogsPath;
const AGENTS_RUNTIME_PATH = runtimeSet.runtimePromptPath;
const HERMES_AGENT_LOG_PATH = path.join(AGENT_RUNTIME_LOGS_PATH, 'agent.log');
const HERMES_ERRORS_LOG_PATH = path.join(AGENT_RUNTIME_LOGS_PATH, 'errors.log');


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
    OUTPUT_PATH = path.join(CANVAS_PATH, 'output.json');
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
let watchTimer;
let graphWatchTimer;
let dirtyWatchEntries = [];
let graphWatchStarted = false;
let graphWatchKey = '';
let activeCanvasRuntime = null;
const componentServices = new Map();
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
    const line = `[${new Date().toISOString()}] [${area}] ${message}${suffix}`;
    console.log(line);
    appendHermesLog(HERMES_AGENT_LOG_PATH, line);
};

const logHermesError = (area, error, details = null) => {
    const message = error instanceof Error ? error.message : String(error || 'Unknown error');
    const suffix = details ? ' ' + JSON.stringify(details) : '';
    const line = `[${new Date().toISOString()}] [${area}] ${message}${suffix}`;
    console.error(line);
    appendHermesLog(HERMES_ERRORS_LOG_PATH, line);

    if (error && error.stack) {
        appendHermesLog(HERMES_ERRORS_LOG_PATH, error.stack);
    }
};

const appendHermesLog = (file, line) => {
    fs.promises.appendFile(file, line + '\n').catch(error => {
        console.error('[log] failed to append ' + file + ': ' + error.message);
    });
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
            appendHermesLog(HERMES_AGENT_LOG_PATH, `${label} ${cleanLine.trimEnd()}`);
            pushAgentDebugLine(line);
        });
};

const shortText = value => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > 160 ? text.slice(0, 157) + '...' : text;
};

const createServiceDispatchId = folder => [
    // folder is <component>/presented/services. The component name is two
    // dirnames up.
    path.basename(path.dirname(path.dirname(folder))).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'component',
    crypto.randomUUID().slice(0, 8)
].join('-');

const startComponentService = folder => {
    const startPath = path.join(folder, 'start.sh');

    if (!fs.existsSync(startPath)) {
        return;
    }

    const signature = JSON.stringify({
        mtimeMs: fs.statSync(startPath).mtimeMs,
        size: fs.statSync(startPath).size
    });
    const current = componentServices.get(folder);

    if (current && current.signature === signature) {
        return;
    }

    if (current) {
        stopComponentService(folder);
    }

    const dispatchId = createServiceDispatchId(folder);
    // folder is <component>/presented/services. The component dir is two up.
    const componentDir = path.dirname(path.dirname(folder));
    const child = childProcess.spawn('/bin/bash', [startPath, dispatchId], {
        cwd: folder,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const processGroups = [child.pid];
    let stderr = '';

    componentServices.set(folder, { signature, processGroups, dispatchId });
    logServer('component-service', 'started', { folder, processGroups, dispatchId });
    canvasGraph.updateDiagnostics(componentDir, 'service', { running: true, lastExit: null, lastStderr: '', dispatchId });

    child.stdout.on('data', chunk => {
        writeProcessOutput('[component-service]', chunk, process.stdout);
        canvasGraph.appendServiceLog(componentDir, String(chunk));
    });
    child.stderr.on('data', chunk => {
        stderr += String(chunk);
        writeProcessOutput('[component-service]', chunk, process.stderr);
        canvasGraph.appendServiceLog(componentDir, String(chunk));
    });
    child.on('error', error => {
        componentServices.delete(folder);
        logHermesError('component-service', error, { folder, message: 'start failed' });
        canvasGraph.updateDiagnostics(componentDir, 'service', { running: false, error: error.message, lastStderr: shortText(stderr) });
    });
    child.on('close', code => {
        const current = componentServices.get(folder);

        if (current && current.signature === signature) {
            componentServices.delete(folder);
        }

        if (code !== 0) {
            logHermesError('component-service', new Error('start.sh exited ' + code), { folder, stderr: shortText(stderr), processGroups, dispatchId });
            canvasGraph.updateDiagnostics(componentDir, 'service', { running: false, lastExit: { code, at: new Date().toISOString() }, lastStderr: shortText(stderr) });
            return;
        }

        logServer('component-service', 'exited', { folder, processGroups, dispatchId });
        canvasGraph.updateDiagnostics(componentDir, 'service', { running: false, lastExit: { code: 0, at: new Date().toISOString() }, lastStderr: shortText(stderr) });
    });
    child.unref();
};

const stopProcessGroup = (processGroup, forceImmediately = false) => {
    try {
        process.kill(-processGroup, 'SIGTERM');
    } catch (error) {
        if (error.code !== 'ESRCH') {
            logHermesError('component-service', error, { processGroup, message: 'terminate failed' });
        }
    }

    const forceTerminate = () => {
        try {
            process.kill(-processGroup, 'SIGKILL');
        } catch (error) {
            if (error.code !== 'ESRCH') {
                logHermesError('component-service', error, { processGroup, message: 'force terminate failed' });
            }
        }
    };

    if (forceImmediately) {
        forceTerminate();
        return;
    }

    setTimeout(forceTerminate, 1500).unref();
};

const stopComponentService = (folder, forceImmediately = false) => {
    const current = componentServices.get(folder);

    if (!current) {
        return;
    }

    current.processGroups.forEach(processGroup => stopProcessGroup(processGroup, forceImmediately));
    componentServices.delete(folder);
    logServer('component-service', 'stopped', { folder });
};

const reconcileComponentServices = () => {
    try {
        const desired = new Set(canvasGraph.componentServiceFolders());

        Array.from(componentServices.keys())
            .filter(folder => !desired.has(folder))
            .forEach(stopComponentService);

        desired.forEach(startComponentService);
    } catch (error) {
        // Canvas input damage should render as a canvas repair card from /input,
        // not crash startup or canvas switching.
        stopAllComponentServices();
        logHermesError('component-service', error, {
            message: 'component services paused until canvas config is repaired'
        });
    }
};

const stopAllComponentServices = (forceImmediately = false) => {
    Array.from(componentServices.keys()).forEach(folder => stopComponentService(folder, forceImmediately));
};

runtimeSet.configureHosts({
    output: writeProcessOutput,
    status: setCurrentAgentDebug
});

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const writeJson = (file, value) => {
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, file);
};

const clearOutputJson = () => {
    try {
        writeJson(OUTPUT_PATH, []);
    } catch (error) {
        logHermesError('shutdown', error, {
            message: 'failed to clear output.json during shutdown'
        });
    }
};

const canvasFiles = createCanvasFiles({
    fs,
    workspacePath: WORKSPACE_PATH,
    canvasTemplateRoot: CANVAS_TEMPLATE_ROOT,
    localAssetRoot: path.join(ROOT, 'skills', 'canvas-creator'),
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

    if (!fs.existsSync(OUTPUT_PATH)) {
        writeJson(OUTPUT_PATH, []);
    }
};

const applyCanvasRuntime = runtime => {
    CANVAS_PATH = runtime.canvasPath;
    INPUT_PATH = runtime.inputPath;
    OUTPUT_PATH = runtime.outputPath;
    return runtime;
};

const createCanvasRuntime = canvasPath => {
    const resolvedCanvasPath = resolveConfigPath(canvasPath);

    return {
        canvasPath: resolvedCanvasPath,
        inputPath: path.join(resolvedCanvasPath, 'input.json'),
        outputPath: path.join(resolvedCanvasPath, 'output.json'),
        started: false,

        start() {
            applyCanvasRuntime(this);
            runtimeSet.refreshRuntime();
            this.started = true;
            ensureActiveCanvasFiles();
            activityPersistence.ensureActivityPersistenceRepo();
            outputQueue.normalizeOutputJobs();
            outputQueue.clearActiveLanes();
            outputQueue.feedHermesOutput();
            reconcileComponentServices();
            broadcastQueueState();
            return this;
        },

        stop() {
            if (activeCanvasRuntime !== this) {
                return this;
            }

            clearTimeout(watchTimer);
            watchTimer = null;
            clearTimeout(graphWatchTimer);
            graphWatchTimer = null;
            dirtyWatchEntries = [];
if (workspaceWatcher) {
    workspaceWatcher.close();
    workspaceWatcher = null;
}
            watchers.forEach(watcher => watcher.close());
            watchers = [];
            stopAllComponentServices();
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
    fs,
    getCanvasPath: () => CANVAS_PATH,
    getOutputPath: () => OUTPUT_PATH,
    logServer,
    logHermesError,
    readJson,
    writeJson,
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
    outputJobKey: job => outputQueue.outputJobKey(job),
    callbackPromptText,
    componentScopePath: canvasGraph.componentScopePath,
    resolveCanvasReference
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
    const componentPath = job.componentPath ? resolveCanvasReference(job.componentPath) : null;
    const laneKey = outputQueue.outputJobKey(job);
    const isCanvasJob = isCanvasScope(job.scope) || laneKey === 'canvas';
    const startedAt = Date.now();
    activeOutputJob = { ...job, id: jobId, componentPath };

    logServer('queue', 'job claimed', {
        canvas: CANVAS_PATH,
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
            canvasPath: CANVAS_PATH,
            inputPath: INPUT_PATH,
            outputPath: OUTPUT_PATH,
            workingDirectory: WORKSPACE_PATH,
            systemPromptPath: AGENTS_RUNTIME_PATH,
            canvasPath: CANVAS_PATH
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

        if (componentPath) {
            canvasGraph.validateComponentFile(componentPath);
        }
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
            body: canvasName(CANVAS_PATH)
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
            body: canvasName(CANVAS_PATH)
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

const resolveFromRoot = value =>
    path.isAbsolute(value) ? value : path.resolve(ROOT, value);

const pointerParts = pointer => {
    if (pointer === '') {
        return [];
    }

    if (!pointer.startsWith('/')) {
        throw new Error('JSON Patch path must start with /: ' + pointer);
    }

    return pointer.slice(1).split('/').map(part =>
        part.replace(/~1/g, '/').replace(/~0/g, '~')
    );
};

const isObject = value =>
    value !== null && typeof value === 'object';

const hasKey = (value, key) =>
    Object.prototype.hasOwnProperty.call(value, key);

const arrayIndex = (key, length, allowEnd = false) => {
    if (!/^(0|[1-9]\d*)$/.test(key)) {
        throw new Error('Invalid array index: ' + key);
    }

    const index = Number(key);
    const max = allowEnd ? length : length - 1;

    if (index < 0 || index > max) {
        throw new Error('Array index out of bounds: ' + key);
    }

    return index;
};

const pointerPath = parts =>
    parts.length ? '/' + parts.map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : '';

const pointerParent = (document, pointer) => {
    const parts = pointerParts(pointer);

    if (!parts.length) {
        return { key: undefined, parent: undefined };
    }

    let parent = document;

    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];

        if (Array.isArray(parent)) {
            parent = parent[arrayIndex(part, parent.length)];
            continue;
        }

        if (!isObject(parent) || !hasKey(parent, part)) {
            throw new Error('Path does not exist: ' + pointerPath(parts.slice(0, index + 1)));
        }

        parent = parent[part];
    }

    if (!isObject(parent)) {
        throw new Error('Path parent is not an object or array: ' + pointer);
    }

    return {
        parent,
        key: parts[parts.length - 1]
    };
};

const cloneJson = value =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const lookupPointer = (document, pointer) => {
    let current = document;

    for (const part of pointerParts(pointer)) {
        if (Array.isArray(current)) {
            current = current[arrayIndex(part, current.length)];
            continue;
        }

        if (!isObject(current) || !hasKey(current, part)) {
            return { exists: false, value: undefined };
        }

        current = current[part];
    }

    return { exists: true, value: cloneJson(current) };
};

const addPointer = (document, pointer, value) => {
    if (pointer === '') {
        return cloneJson(value);
    }

    const { parent, key } = pointerParent(document, pointer);

    if (Array.isArray(parent)) {
        parent.splice(key === '-' ? parent.length : arrayIndex(key, parent.length, true), 0, cloneJson(value));
    } else {
        parent[key] = cloneJson(value);
    }

    return document;
};

const removePointer = (document, pointer) => {
    if (pointer === '') {
        return undefined;
    }

    const { parent, key } = pointerParent(document, pointer);

    if (Array.isArray(parent)) {
        parent.splice(arrayIndex(key, parent.length), 1);
    } else {
        if (!hasKey(parent, key)) {
            throw new Error('Path does not exist: ' + pointer);
        }

        delete parent[key];
    }

    return document;
};

const replacePointer = (document, pointer, value) => {
    if (pointer === '') {
        return cloneJson(value);
    }

    const { parent, key } = pointerParent(document, pointer);

    if (Array.isArray(parent)) {
        parent[arrayIndex(key, parent.length)] = cloneJson(value);
    } else {
        if (!hasKey(parent, key)) {
            throw new Error('Path does not exist: ' + pointer);
        }

        parent[key] = cloneJson(value);
    }

    return document;
};

const applyJsonPatch = (document, ops) =>
    ops.reduce((next, op) => {
        if (op.op === 'add') {
            return addPointer(next, op.path, op.value);
        }

        if (op.op === 'remove') {
            return removePointer(next, op.path);
        }

        if (op.op === 'replace') {
            return replacePointer(next, op.path, op.value);
        }

        throw new Error('Unsupported JSON Patch op: ' + op.op);
    }, cloneJson(document));

const inverseOps = ops =>
    [...ops].reverse().map(op => {
        if (op.op === 'add') {
            return op.beforeExists
                ? { op: 'replace', path: op.appliedPath || op.path, value: op.before }
                : { op: 'remove', path: op.appliedPath || op.path };
        }

        if (op.op === 'remove') {
            return { op: 'add', path: op.path, value: op.before };
        }

        if (op.op === 'replace') {
            return { op: 'replace', path: op.path, value: op.before };
        }

        throw new Error('Unsupported JSON Patch op: ' + op.op);
    });

const applyPatchSet = patchSet => {
    patchSet.forEach(patch => {
        const file = resolveFromRoot(patch.file);
        const current = readJson(file);
        writeJson(file, applyJsonPatch(current, patch.ops || []));
    });
};

const ensurePatchBefores = patchSet =>
    patchSet.map(patch => {
        const file = resolveFromRoot(patch.file);
        let current = readJson(file);

        const ops = (patch.ops || []).map(op => {
            const nextOp = { ...op };
            let lookup;

            if (op.op === 'add' && op.path !== '') {
                const { parent } = pointerParent(current, op.path);

                lookup = Array.isArray(parent)
                    ? { exists: false, value: undefined }
                    : lookupPointer(current, op.path);
            } else {
                lookup = lookupPointer(current, op.path);
            }

            if (!Object.hasOwn(nextOp, 'beforeExists')) {
                nextOp.beforeExists = lookup.exists;
            }

            if (lookup.exists && !Object.hasOwn(nextOp, 'before')) {
                nextOp.before = lookup.value;
            }

            if (op.op === 'add' && !Object.hasOwn(nextOp, 'appliedPath')) {
                if (op.path === '') {
                    nextOp.appliedPath = '';
                } else {
                    const parts = pointerParts(op.path);
                    const { parent, key } = pointerParent(current, op.path);

                    nextOp.appliedPath = Array.isArray(parent) && key === '-'
                        ? pointerPath([...parts.slice(0, -1), String(parent.length)])
                        : op.path;
                }
            }

            current = applyJsonPatch(current, [op]);
            return nextOp;
        });

        return { ...patch, ops };
    });

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

    // State-only edits (canvas/per-component state.json) don't alter
    // component HTML, mount lifecycles, or services — only what canvas.js
    // does with state. Ship just the new state so the client can re-call
    // place() without re-staging items.
    if (entries.every(entry => entry.kind === 'canvas-state')) {
        return { type: 'state-changed', state: rendered.state || { canvas: null, components: {} } };
    }

    if (entries.every(entry => entry.kind === 'component') && Array.isArray(rendered.components)) {
        const dirtyFolders = new Set(entries.map(entry => entry.path));
        const components = rendered.components.filter(component =>
            dirtyFolders.has(canvasGraph.componentFolderPath(component.componentPath)));

        if (components.length === 0) return null;
        return { type: 'components-changed', components };
    }

    return null;
};

const scheduleWatchRefresh = entry => {
    if (entry) {
        dirtyWatchEntries.push(entry);
    }

    clearTimeout(graphWatchTimer);
    graphWatchTimer = setTimeout(() => {
        const entries = dirtyWatchEntries;
        dirtyWatchEntries = [];

        let rendered;

        try {
            rendered = canvasGraph.renderedInput();
            refreshGraphWatchers();
            reconcileComponentServices();
        } catch (error) {
            logHermesError('watch', error, { message: 'watch error' });
            broadcast();
            return;
        }

        broadcast(componentChangePayload(entries, rendered));
    }, 50);
};

const scheduleWorkspaceRefresh = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
        try {
            watchWorkspace();
        } catch (error) {
            logHermesError('watch', error, { message: 'workspace path watch error' });
            broadcast({ type: 'canvases-changed' });
            return;
        }

        broadcast({ type: 'canvases-changed' });
    }, 50);
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
                // Component watches are opt-in by path: only events under
                // presented/ (the live state) and the per-component state
                // file at the component root trigger refresh. Anything else —
                // data/, diagnostics/, .presented/, future siblings — is
                // implicitly ignored.
                if (entry.kind === 'component' && filename) {
                    const isPresented = filename === 'presented' || filename.startsWith('presented/');
                    const isState = filename === 'state.json';
                    if (!isPresented && !isState) return;
                }
                // The canvas-root watch covers state.json (fast path: re-place
                // without re-staging) and canvas.js (presentation reload).
                // Synthesise a sub-kind so componentChangePayload can route
                // each to the right path.
                if (entry.kind === 'canvas-root' && filename) {
                    if (filename === 'state.json') {
                        scheduleWatchRefresh({ ...entry, kind: 'canvas-state' });
                        return;
                    }
                    if (filename === 'canvas.js') {
                        scheduleWatchRefresh({ ...entry, kind: 'canvas-js' });
                        return;
                    }
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


const componentFolderPath = componentPath =>
    fs.existsSync(componentPath) && fs.statSync(componentPath).isDirectory()
        ? componentPath
        : path.dirname(componentPath);

const componentFeatureFile = componentPath =>
    path.join(componentFolderPath(componentPath), 'feature-requirements.md');

const readComponentFeatureText = componentPath => {
    const file = componentFeatureFile(componentPath);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
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
    'Keep feature-requirements.md user-facing, concise, plain-language, and faithful to what the component does or is meant to do.',
    "If the requirements and implementation disagree, resolve the mismatch by updating the implementation, the requirements, or both, based on the user's intent.",
    'Do not add unrelated capabilities or preserve inaccurate requirements.'
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

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');

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
            const workspace = {
                migrationPending: isMigrationPending(),
                migrationRunning: MIGRATION_STATE.running,
                migrationLastError: MIGRATION_STATE.lastError,
                lastSkillsSha: SKILLS_SYNC.sha || null,
                lastSkillsParentSha: SKILLS_SYNC.parentSha || null
            };
            send(res, 200, JSON.stringify({ ...rendered, workspace }), 'application/json; charset=utf-8');
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

        if (req.method === 'POST' && url.pathname === '/canvas') {
            const body = JSON.parse(await readBody(req));

            canvasFiles.switchCanvas(String(body.name || ''));
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
            broadcast();
            send(res, 201, JSON.stringify({
                current: canvasName(CANVAS_PATH),
                canvases: canvasFiles.availableCanvases()
            }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/output') {
            // Belt-and-suspenders over the overlay: even if the client bypasses
            // the migration UI (programmatic fetch, browser bookmark, etc.),
            // refuse to queue new agent work while the workspace is being
            // reconciled. Two agents racing the same workspace = corrupted
            // git state + unpredictable outcomes.
            if (MIGRATION_STATE.running) {
                send(res, 409, 'workspace migration in progress — try again when it finishes');
                return;
            }
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
                send(res, 204, '');
            } catch (error) {
                send(res, 400, error.message);
            }
            return;
        }

        if (req.method === 'POST' && url.pathname === '/workspace/retry-migration') {
            const result = dispatchMigration();
            if (result.ok) {
                send(res, 202, '');
            } else if (result.reason === 'already-running') {
                send(res, 409, 'migration already running');
            } else if (result.reason === 'no-marker') {
                send(res, 204, '');
            } else {
                send(res, 500, 'unknown dispatch state');
            }
            return;
        }

        if (req.method === 'POST' && url.pathname === '/workspace/cancel-migration') {
            // Asks the runtime to stop the in-flight agent. The promise the
            // runtime returned will reject when the child exits, the existing
            // .catch handler captures the error, and the marker stays put —
            // user lands back on the overlay with Try Again available.
            if (!MIGRATION_STATE.running) {
                send(res, 409, 'no migration to cancel');
                return;
            }
            const debug = activeRuntime.currentDebug ? activeRuntime.currentDebug() : null;
            const pid = debug && typeof debug.pid === 'number' ? debug.pid : null;
            if (!pid) {
                send(res, 409, 'agent pid unknown — cannot cancel');
                return;
            }
            try {
                process.kill(pid, 'SIGTERM');
                logServer('migration', 'cancel requested', { pid });
                send(res, 202, '');
            } catch (error) {
                logServer('migration', 'cancel failed', { pid, error: error.message });
                send(res, 500, 'kill failed: ' + error.message);
            }
            return;
        }

        if (req.method === 'POST' && url.pathname === '/state') {
            try {
                const body = JSON.parse(await readBody(req) || '{}');
                const scope = String(body.scope || '');
                const data = body.data === undefined ? null : body.data;

                if (scope !== 'canvas' && scope !== 'component') {
                    send(res, 400, 'scope must be "canvas" or "component"');
                    return;
                }

                let targetFile;
                if (scope === 'canvas') {
                    targetFile = canvasGraph.canvasStatePath();
                } else {
                    const componentPath = String(body.componentPath || '');
                    if (!componentPath) {
                        send(res, 400, 'componentPath required for scope=component');
                        return;
                    }
                    const absolute = resolveCanvasReference(componentPath);
                    targetFile = canvasGraph.componentStatePath(absolute);
                }

                if (!pathIsInside(targetFile, CANVAS_PATH)) {
                    send(res, 403, 'state file outside canvas');
                    return;
                }

                fs.mkdirSync(path.dirname(targetFile), { recursive: true });
                fs.writeFileSync(targetFile, JSON.stringify(data, null, 2) + '\n');
                send(res, 204, '');
            } catch (error) {
                send(res, 400, error.message);
            }
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

        const inputFile = url.pathname.match(/^\/input\/(\d+)\/file$/);

        if (req.method === 'GET' && inputFile) {
            const component = canvasGraph.leafComponents()[Number(inputFile[1])]?.component;

            if (!component?.file) {
                send(res, 404, 'Input file not found');
                return;
            }

            streamCanvasFile(req, res, component.file, component.type);
            return;
        }

        const inputResource = url.pathname.match(/^\/input\/(\d+)\/resources\/(.+)$/);

        if (req.method === 'GET' && inputResource) {
            const entry = canvasGraph.leafComponents()[Number(inputResource[1])];
            const component = entry?.component;
            const name = decodeURIComponent(inputResource[2]);
            const resource = component && canvasGraph.componentResources(entry.componentPath, component)[name];

            if (!resource?.path) {
                send(res, 404, 'Input resource not found');
                return;
            }

            streamCanvasFile(req, res, resource.path, resource.mime || resource.type);
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
                send(res, 200, JSON.stringify({
                    text: readComponentFeatureText(entry.componentPath)
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

        const componentFile = url.pathname.match(/^\/component\/(.+)\/file$/);

        if (req.method === 'GET' && componentFile) {
            const componentPath = decodeURIComponent(componentFile[1]);
            const component = canvasGraph.findLeafComponentByPath(componentPath)?.component;

            if (!component?.file) {
                send(res, 404, 'Component file not found');
                return;
            }

            streamCanvasFile(req, res, component.file, component.type);
            return;
        }

        const componentResource = url.pathname.match(/^\/component\/(.+)\/resources\/(.+)$/);

        if (req.method === 'GET' && componentResource) {
            const componentPath = decodeURIComponent(componentResource[1]);
            const component = canvasGraph.findLeafComponentByPath(componentPath)?.component;
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
    stopAllComponentServices(true);
    commitShutdownState(reason || 'application was shut down');

    if (activeCanvasRuntime) {
        activeCanvasRuntime.stop();
        activeCanvasRuntime = null;
        clearOutputJson();
        return true;
    }

    clearOutputJson();
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

server.listen(PORT, '127.0.0.1', () => {
    const address = server.address();
    const resolvedPort = address && typeof address === 'object' ? address.port : PORT;

    console.log('Build: ' + SERVER_BUILD);
    console.log('Server at http://127.0.0.1:' + resolvedPort);
    console.log('Canvas: ' + CANVAS_PATH);
    console.log('Input: ' + INPUT_PATH);
    console.log('Output: ' + OUTPUT_PATH);

    // Catch-all detection for workspace-level errors. If anything at the
    // workspace's top-level state failed to load, write a marker with the
    // captured errors so the next dispatchMigration() call fires the fix
    // agent. Canvas- and component-level issues are intentionally not
    // included here — those have their own repair flows. A marker that
    // survived from a previous startup (agent failure or rejection) also
    // stays in place; dispatchMigration() is a no-op when nothing is wrong.
    const workspaceErrors = collectWorkspaceErrors();
    if (workspaceErrors.length > 0) {
        logServer('workspace', 'errors detected at startup', { errors: workspaceErrors });
        writeWorkspaceFixMarker(workspaceErrors, {
            syncedSkillsSha: SKILLS_SYNC.sha || null,
            syncedSkillsParentSha: SKILLS_SYNC.parentSha || null
        });
    }
    dispatchMigration();
});
