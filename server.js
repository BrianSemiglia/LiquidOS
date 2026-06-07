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
const { buildWorkspaceFixPrompt } = require('./workspace/run-migration');

const WORKSPACE_ERROR_FILE_REL = path.join('.liquidos', 'workspace-error');

const ROOT = __dirname;
const SERVER_BUILD = 'hermes-output-server-2026-05-10-canvases-git-timeline';

const VALID_AGENT_KINDS = new Set(['codex', 'claude-code', 'hermes', 'pi', 'none',
    'callback-dispatch-test', 'canvas-build-test', 'component-repair-test', 'canvas-repair-test',
    'prompt-bar-test']);

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

// Mirror of how many workspace-level errors the last detector pass saw.
// /input surfaces this so the client knows whether to show the "couldn't
// fix this workspace" overlay. The on-disk .liquidos/workspace-error file
// is the persistent snapshot; this counter is just for fast reads. It's
// kept in sync via syncWorkspaceErrorFile.
let workspaceErrorCount = 0;

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

// Writes the workspace-error file. The file is never deleted — empty
// `errors` arrays are written in place so git history follows a single
// file across success/failure cycles without needing --follow. The
// leading "_readme" key explains the file to anyone (or any agent)
// looking at it in isolation, so an empty errors array isn't mistaken
// for "something's wrong here."
const writeWorkspaceErrorFile = (errors, context = {}) => {
    const errorFilePath = path.join(WORKSPACE_PATH, WORKSPACE_ERROR_FILE_REL);
    fs.mkdirSync(path.dirname(errorFilePath), { recursive: true });
    const body = {
        _readme: 'Snapshot of the runtime\'s most recent workspace-level error check. ' +
            'An empty `errors` array means the workspace passes its checks; presence of this file alone does not indicate a problem.',
        errors,
        ...context
    };
    fs.writeFileSync(errorFilePath, JSON.stringify(body, null, 2) + '\n');
};

const syncWorkspaceErrorFile = errors => {
    workspaceErrorCount = errors.length;
    writeWorkspaceErrorFile(errors);
};

// Re-runs the detector, snapshots the result to .liquidos/workspace-error,
// and — if anything is broken — enqueues an agent job at the front of the
// queue to fix it. The job runs through the regular processOutputJob
// pipeline, which commits its outcome via activityPersistence like any
// canvas job. processOutputJob calls this again after each job completes,
// so a still-broken workspace auto-loops; a clean workspace lets normal
// canvas jobs proceed.
const enqueueWorkspaceFixJobIfErrors = async () => {
    const errors = collectWorkspaceErrors();
    syncWorkspaceErrorFile(errors);
    if (!errors.length) {
        broadcast();
        return false;
    }

    const alreadyQueued = outputQueue.activeOutputJobs()
        .some(job => job.componentKey === 'workspace-fix');
    if (alreadyQueued) {
        broadcast();
        return false;
    }

    const prompt = buildWorkspaceFixPrompt({
        workspacePath: WORKSPACE_PATH,
        errors
    });

    await outputQueue.prependOutputJob({
        id: 'workspace-fix-' + Date.now(),
        status: 'pending',
        scope: WORKSPACE_PATH,
        componentKey: 'workspace-fix',
        event: 'Runtime did try to fix workspace',
        prompt
    });
    broadcast();
    outputQueue.feedHermesOutput();
    return true;
};

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

const createServiceDispatchId = folder => [
    // folder is <component>/presented/services. The component name is two
    // dirnames up.
    path.basename(path.dirname(path.dirname(folder))).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'component',
    crypto.randomUUID().slice(0, 8)
].join('-');

// Hash every regular file in the services directory by content. This
// is what we sign a running service against so a same-content
// atomic-swap (the agent's `.presented/ → presented/` idiom) doesn't
// look like a change — only an actual byte-level edit to start.sh,
// render.js, etc. should cause a restart. mtime-based signatures
// were wrong: the atomic swap brings in new inodes with new mtimes
// but identical content, so the service was killed and restarted on
// every iteration the agent did, leaving multi-minute windows where
// view.html → view.json was broken.
const computeServiceSignature = folder => {
    const hash = crypto.createHash('sha256');
    const walk = (dir, rel) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            const sub = rel ? rel + '/' + entry.name : entry.name;
            if (entry.isDirectory()) {
                walk(full, sub);
            } else if (entry.isFile()) {
                let buf;
                try { buf = fs.readFileSync(full); } catch { continue; }
                hash.update(sub);
                hash.update(Buffer.from([0]));
                hash.update(buf);
            }
        }
    };
    walk(folder, '');
    return hash.digest('hex');
};

const startComponentService = folder => {
    const startPath = path.join(folder, 'start.sh');

    if (!fs.existsSync(startPath)) {
        return;
    }

    const signature = computeServiceSignature(folder);
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
            outputQueue.resetQueue();
            outputQueue.feedHermesOutput();
            reconcileComponentServices();
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

        // Re-check workspace health after every job. If still broken,
        // this prepends another workspace-fix job; if clean, it just
        // updates the snapshot. Runs unconditionally so that a canvas
        // job that incidentally repaired (or broke) the workspace also
        // converges the state machine.
        await enqueueWorkspaceFixJobIfErrors().catch(error => {
            logHermesError('workspace-fix', error, { message: 'post-job workspace check failed' });
        });
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

    // When only component view files changed, ship the affected components
    // in a typed event so the client can update them without a full reload.
    if (entries.every(entry => entry.kind === 'component') && Array.isArray(rendered.components)) {
        const dirtyFolders = new Set(entries.map(entry => entry.path));
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
        reconcileComponentServices();
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
                // Every fs.watch event broadcasts a workspace-file SSE event
                // so external listeners (canvas.js subscribers, component
                // services) can re-fetch whatever they care about. The
                // harness's own kind-specific routing happens after, on top.
                broadcastWorkspaceFile(entry.path, filename);

                // Component watches are opt-in by path: only events under
                // presented/ (the live state) trigger the harness's render
                // refresh. Anything else — data/, diagnostics/, .presented/,
                // state.json, future siblings — is implicitly ignored by the
                // harness, even though the workspace-file event still fires
                // above so canvas.js can observe it if it wants.
                if (entry.kind === 'component' && filename) {
                    const isPresented = filename === 'presented' || filename.startsWith('presented/');
                    if (!isPresented) return;
                    // A presented/ edit is the agent's (or human's) attempt
                    // to repair. Clear the runtime category so the Repair
                    // button gets the new code a fresh slate. If the bug
                    // is still there, the next throw POSTs ok:false again.
                    // Exclude view.json — render.js auto-regenerates it on
                    // every service restart (port substitution), which is
                    // service-internal churn, not a code edit.
                    if (filename !== 'presented/view.json') {
                        canvasGraph.updateDiagnostics(entry.path, 'runtime', { ok: true, error: null });
                    }
                }
                // The canvas-root watch covers canvas.js (presentation reload).
                if (entry.kind === 'canvas-root' && filename) {
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


const componentFeatureFile = componentPath =>
    path.join(canvasGraph.componentFolderPath(componentPath), 'presented', 'feature-requirements.txt');

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
        const view = JSON.parse(fs.readFileSync(path.join(folder, 'presented', 'view.json'), 'utf8'));
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

const workspaceFileType = file => ({
    '.json': 'application/json; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
})[path.extname(file).toLowerCase()] || 'application/octet-stream';

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
        const canvasOfComponent = (componentAbsPath) => {
            // <workspace>/<canvas>/components/<name> → <canvas>
            const rel = path.relative(WORKSPACE_PATH, componentAbsPath);
            const parts = rel.split(path.sep).filter(Boolean);
            return parts[0] || '';
        };

        // Share toggle is the single share.sh / unshare.sh invocation.
        // Both scripts own writing share.json and updating .share/feed.json,
        // so the endpoint doesn't have to coordinate any of the pieces.
        const runShareScript = (script, args) => {
            const { spawnSync } = require('node:child_process');
            const scriptPath = path.join(ROOT, 'skills', 'share', 'scripts', script);
            const result = spawnSync('bash', [scriptPath, WORKSPACE_PATH, ...args], { encoding: 'utf8' });
            if (result.status !== 0) {
                return { ok: false, error: (result.stderr || result.stdout || 'unknown').trim() };
            }
            return { ok: true };
        };

        if (url.pathname === '/canvas/share') {
            if (req.method === 'GET') {
                const canvasName = url.searchParams.get('canvas') || '';
                if (!canvasName) { send(res, 400, 'canvas required'); return; }
                const flag = readShareFlag(canvasShareFile(canvasName));
                send(res, 200, JSON.stringify({ shared: flag === true }), 'application/json; charset=utf-8');
                return;
            }
            if (req.method === 'POST') {
                let body;
                try { body = JSON.parse(await readBody(req) || '{}'); }
                catch { send(res, 400, 'invalid json'); return; }
                const canvasName = String(body.canvas || '');
                if (!canvasName) { send(res, 400, 'canvas required'); return; }
                const canvasPath = path.join(WORKSPACE_PATH, canvasName);
                if (!pathIsInside(canvasPath, WORKSPACE_PATH) || !fs.existsSync(canvasPath) || !fs.statSync(canvasPath).isDirectory()) {
                    send(res, 404, 'canvas not found');
                    return;
                }
                const shared = Boolean(body.shared);
                // share.sh / unshare.sh own everything: bundle build,
                // tarball, feed regeneration, and the share.json flag.
                // The endpoint just invokes the right one and re-
                // broadcasts over gossipsub so peers' caches converge.
                const result = shared
                    ? runShareScript('share.sh', [canvasName])
                    : runShareScript('unshare.sh', [canvasName]);
                if (!result.ok) {
                    send(res, 500, (shared ? 'share failed: ' : 'unshare failed: ') + result.error);
                    return;
                }
                rebroadcastFeed();
                send(res, 200, JSON.stringify({ shared }), 'application/json; charset=utf-8');
                return;
            }
        }

        const componentShare = url.pathname.match(/^\/component\/(.+)\/share$/);
        if (componentShare) {
            const componentPath = decodeURIComponent(componentShare[1]);
            const entry = canvasGraph.findAnyByPath(componentPath);
            if (!entry) { send(res, 404, 'component not found'); return; }
            const folder = canvasGraph.componentFolderPath(entry.componentPath);
            if (req.method === 'GET') {
                const canvasName = canvasOfComponent(folder);
                const canvasFlag = readShareFlag(canvasShareFile(canvasName));
                const compFlag = readShareFlag(componentShareFile(folder));
                // Effective: canvas must be opted in. Within an opted-in
                // canvas, components cascade unless explicitly opted out.
                const effective = canvasFlag === true && compFlag !== false;
                send(res, 200, JSON.stringify({
                    shared: effective,
                    canvasShared: canvasFlag === true,
                    componentOverride: compFlag
                }), 'application/json; charset=utf-8');
                return;
            }
            if (req.method === 'POST') {
                let body;
                try { body = JSON.parse(await readBody(req) || '{}'); }
                catch { send(res, 400, 'invalid json'); return; }
                writeShareFlag(componentShareFile(folder), Boolean(body.shared));
                send(res, 200, JSON.stringify({ shared: Boolean(body.shared) }), 'application/json; charset=utf-8');
                return;
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

        if (req.method === 'GET' && url.pathname === '/network/search') {
            // Search is a pure local-cache lookup over (a) our own feed and
            // (b) every peer feed we've heard via the gossipsub topic. The
            // network never sees the query string — that's the privacy
            // story. Install (below) is the only thing that dials a peer.
            //
            // Optional `n` and `timeout_ms` let the caller wait for the
            // local cache to grow. The handler polls the cache every
            // ~500ms until `n` matching results are present or the timeout
            // expires; it returns whatever is in hand when one of those
            // conditions hits. The recipient just looks at results.length.
            const query = (url.searchParams.get('q') || '').trim().toLowerCase();
            const wantN = Math.max(0, Number.parseInt(url.searchParams.get('n') || '0', 10) || 0);
            const timeoutMs = Math.max(0, Number.parseInt(url.searchParams.get('timeout_ms') || '0', 10) || 0);
            const matchesQuery = (bundle) => {
                if (!query) return true;
                const haystack = [
                    bundle.name || '',
                    bundle.subtitle || '',
                    (bundle.tags || []).join(' '),
                    bundle.canvasRequirements || '',
                    Array.isArray(bundle.components)
                        ? bundle.components.map(c => typeof c === 'string' ? c : (c?.name || '')).join(' ')
                        : ''
                ].join(' ').toLowerCase();
                return haystack.includes(query);
            };

            const collectResults = () => {
                const acc = [];
                // Local bundles (tagged peerId: null so the UI labels them "local").
                const feedFile = path.join(WORKSPACE_PATH, '.share', 'feed.json');
                if (fs.existsSync(feedFile)) {
                    try {
                        const localFeed = JSON.parse(fs.readFileSync(feedFile, 'utf8'));
                        for (const bundle of (localFeed.bundles || [])) {
                            if (matchesQuery(bundle)) acc.push({ ...bundle, peerId: null });
                        }
                    } catch { /* fall through */ }
                }
                // Remote bundles from the gossipsub cache.
                if (networkFeedSub) {
                    for (const [, entry] of networkFeedSub.cache) {
                        const bundles = entry.feed && Array.isArray(entry.feed.bundles) ? entry.feed.bundles : [];
                        for (const bundle of bundles) {
                            if (matchesQuery(bundle)) acc.push({ ...bundle, peerId: entry.peerId });
                        }
                    }
                }
                return acc;
            };

            const sleep = ms => new Promise(r => setTimeout(r, ms));
            const started = Date.now();
            let results = collectResults();
            while (wantN > 0 && results.length < wantN && Date.now() - started < timeoutMs) {
                await sleep(500);
                results = collectResults();
            }
            send(res, 200, JSON.stringify({ results }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/network/install') {
            // First-cut stub: install only works for local bundles
            // (peerId null). When peerId is set, we'll eventually
            // libp2p-fetch the bundle. For now, return 501.
            let body;
            try { body = JSON.parse(await readBody(req) || '{}'); }
            catch (e) { send(res, 400, 'invalid json'); return; }
            const peerId = body.peerId || null;
            const hash = body.hash || '';
            if (!/^sha256-[0-9a-f]{64}$/.test(hash)) {
                send(res, 400, 'invalid hash');
                return;
            }
            const { spawnSync } = require('node:child_process');
            const installScript = path.join(ROOT, 'skills', 'share', 'scripts', 'install.sh');

            // Two install sources: local (peerId null, bundle already
            // on disk under .share/published/) and remote (peerId set,
            // bundle fetched from the peer via libp2p). Both end up
            // running install.sh against a bundle directory.
            let entry = null;
            let bundleSrc = null;
            let tempDir = null;

            if (!peerId) {
                // Local: look up the bundle in our own feed + published dir.
                const publishedDir = path.join(WORKSPACE_PATH, '.share', 'published');
                const feedFile = path.join(WORKSPACE_PATH, '.share', 'feed.json');
                let feed = { bundles: [] };
                try { feed = JSON.parse(fs.readFileSync(feedFile, 'utf8')); } catch {}
                entry = (feed.bundles || []).find(b => b.hash === hash);
                if (!entry) { send(res, 404, 'bundle not found in local feed'); return; }
                bundleSrc = path.join(publishedDir, entry.name);
                if (!fs.existsSync(bundleSrc)) { send(res, 404, 'bundle directory missing on disk'); return; }
            } else {
                // Remote: find the bundle in the gossipsub cache (so we
                // know its name + can address the peer), then dial the
                // peer's bundle protocol and untar the result.
                if (!networkNode || !networkModule || !networkFeedSub) {
                    send(res, 503, 'network not running'); return;
                }
                let cachedEntry = null;
                for (const [pid, peerEntry] of networkFeedSub.cache) {
                    if (pid !== peerId) continue;
                    const bundles = peerEntry.feed && Array.isArray(peerEntry.feed.bundles) ? peerEntry.feed.bundles : [];
                    cachedEntry = bundles.find(b => b.hash === hash);
                    if (cachedEntry) break;
                }
                if (!cachedEntry) { send(res, 404, 'bundle not in cached feed for that peer'); return; }
                entry = cachedEntry;
                let bundleBytes;
                try {
                    bundleBytes = await networkModule.fetchBundle(networkNode, peerId, hash);
                } catch (error) {
                    send(res, 502, 'bundle fetch failed: ' + (error?.message || error)); return;
                }
                if (!bundleBytes || bundleBytes.length === 0) {
                    send(res, 404, 'peer did not return bundle bytes'); return;
                }
                tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'liquidos-install-'));
                const tarPath = path.join(tempDir, hash + '.tar');
                fs.writeFileSync(tarPath, bundleBytes);
                const untar = spawnSync('tar', ['-xf', tarPath, '-C', tempDir], { encoding: 'utf8' });
                if (untar.status !== 0) {
                    send(res, 500, 'untar failed: ' + (untar.stderr || untar.stdout || 'unknown'));
                    return;
                }
                bundleSrc = path.join(tempDir, entry.name);
                if (!fs.existsSync(bundleSrc)) {
                    send(res, 500, 'expected ' + entry.name + '/ inside the fetched TAR, but it was not there');
                    return;
                }
            }

            // Suffix the canvas name with a short hash slice so a
            // re-install doesn't collide with the existing canvas.
            const targetName = entry.name + '-' + hash.slice('sha256-'.length, 'sha256-'.length + 6);
            const result = spawnSync('bash', [installScript, bundleSrc, WORKSPACE_PATH, targetName], {
                encoding: 'utf8'
            });
            if (tempDir) {
                try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
            }
            if (result.status !== 0) {
                send(res, 500, 'install failed: ' + (result.stderr || result.stdout || 'unknown'));
                return;
            }
            // Parse the last line of stdout — install.sh prints a JSON summary.
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

        const networkFeed = url.pathname.match(/^\/network\/feed\/(.+)$/);

        if (req.method === 'GET' && networkFeed) {
            if (!networkNode || !networkModule) {
                send(res, 503, 'network not running');
                return;
            }
            const target = decodeURIComponent(networkFeed[1]);
            try {
                const bytes = await networkModule.fetchFeed(networkNode, target);
                send(res, 200, bytes.toString('utf8'), 'application/json; charset=utf-8');
            } catch (error) {
                send(res, 502, 'feed fetch failed: ' + (error?.message || error));
            }
            return;
        }

        const networkBundle = url.pathname.match(/^\/network\/bundle\/(.+?)\/(sha256-[0-9a-f]{64})$/);

        if (req.method === 'GET' && networkBundle) {
            if (!networkNode || !networkModule) {
                send(res, 503, 'network not running');
                return;
            }
            const target = decodeURIComponent(networkBundle[1]);
            const hash = networkBundle[2];
            try {
                const bytes = await networkModule.fetchBundle(networkNode, target, hash);
                if (!bytes || bytes.length === 0) {
                    send(res, 404, 'bundle not found');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'application/x-tar',
                    'Content-Length': bytes.length,
                    'Cache-Control': 'no-cache'
                });
                res.end(bytes);
            } catch (error) {
                send(res, 502, 'bundle fetch failed: ' + (error?.message || error));
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
            const activeFixJob = outputQueue.activeOutputJobs()
                .find(job => job.componentKey === 'workspace-fix');
            const workspace = {
                migrationPending: workspaceErrorCount > 0,
                migrationRunning: Boolean(activeFixJob && activeFixJob.status === 'running')
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
            // No need to gate on workspace-fix state: the queue serializes
            // jobs and workspace-fix preempts (prependOutputJob), so any
            // canvas job queued while the workspace is broken just waits
            // until the fix runs.
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

        if (req.method === 'POST' && url.pathname === '/workspace/retry-migration') {
            // Same path the auto-loop takes — detect, snapshot, enqueue at
            // front if there's anything to fix.
            const enqueued = await enqueueWorkspaceFixJobIfErrors();
            send(res, enqueued ? 202 : 204, '');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/workspace/cancel-migration') {
            // Stops the in-flight fix agent. The job's catch handler in
            // processOutputJob commits a 'failed' record; the post-job
            // detector still re-runs, so if errors remain the user lands
            // on the overlay with Try Again.
            const activeFixJob = outputQueue.activeOutputJobs()
                .find(job => job.status === 'running' && job.componentKey === 'workspace-fix');
            if (!activeFixJob) {
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

        const workspaceFile = url.pathname.match(/^\/workspace\/file\/(.+)$/);

        if (req.method === 'GET' && workspaceFile) {
            // Generic read access to anything under WORKSPACE_PATH. canvas.js
            // and component code use this to fetch files the harness doesn't
            // hand them directly (state.json, custom presets, anything). A
            // directory path returns a JSON listing so callers can discover
            // children. The harness stays agnostic about what's inside.
            const rel = decodeURIComponent(workspaceFile[1]);
            const file = path.resolve(WORKSPACE_PATH, rel);
            if (!file.startsWith(WORKSPACE_PATH + path.sep) && file !== WORKSPACE_PATH) {
                send(res, 403, 'path escapes workspace');
                return;
            }
            if (!fs.existsSync(file)) {
                send(res, 404, 'not found');
                return;
            }
            if (fs.statSync(file).isDirectory()) {
                const entries = fs.readdirSync(file, { withFileTypes: true })
                    .map(entry => ({
                        name: entry.name,
                        type: entry.isDirectory() ? 'directory' : 'file'
                    }));
                send(res, 200, JSON.stringify({ path: rel, entries }), 'application/json; charset=utf-8');
                return;
            }
            streamFile(req, res, file, workspaceFileType(file));
            return;
        }

        if (req.method === 'POST' && url.pathname === '/workspace/writes') {
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
                reconcileComponentServices();
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

        const componentFile = url.pathname.match(/^\/component\/(.+)\/file$/);

        if (req.method === 'GET' && componentFile) {
            const componentPath = decodeURIComponent(componentFile[1]);
            const component = canvasGraph.findAnyByPath(componentPath)?.component;

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
    stopAllComponentServices(true);
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
// Subscription handle returned from subscribeFeedTopic — exposes .cache
// (Map<peerId, { peerId, multiaddrs, feed, receivedAt }>), .broadcast()
// to push our latest feed, and .stop() for shutdown.
let networkFeedSub = null;
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
        networkFeedSub = await networkModule.subscribeFeedTopic(
            networkNode,
            path.join(WORKSPACE_PATH, '.share'),
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
const rebroadcastFeed = () => {
    if (networkFeedSub) {
        Promise.resolve(networkFeedSub.broadcast()).catch(() => {});
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

    // Catch-all detection for workspace-level errors. Snapshots state to
    // .liquidos/workspace-error and prepends a workspace-fix job if there's
    // anything broken. Canvas- and component-level issues are intentionally
    // not included here — those have their own repair flows.
    enqueueWorkspaceFixJobIfErrors().catch(error => {
        logHermesError('workspace-fix', error, { message: 'startup workspace check failed' });
    });
});
