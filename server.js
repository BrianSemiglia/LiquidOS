const http = require('http');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGitTimeline } = require('./canvas/git-timeline');
const { createAgentProviders } = require('./agent/providers');
const { CodexAgent, configureCodexAgent } = require('./agent/codex');
const { HermesAgent, configureHermesAgent } = require('./agent/hermes');
const { ClaudeCodeAgent, configureClaudeCodeAgent } = require('./agent/claude-code');
const { createCanvasFiles } = require('./canvas/files');
const { createCanvasGraph } = require('./canvas/graph');
const { createOutputQueue } = require('./canvas/output-queue');
const { createPromptBuilder } = require('./canvas/prompt-builder');
const pty = require('node-pty');

const ROOT = __dirname;
const SERVER_BUILD = 'hermes-output-server-2026-05-10-canvases-git-timeline';

const argValue = (name, fallback) => {
    const prefix = name + '=';
    const inline = process.argv.find(arg => arg.startsWith(prefix));

    if (inline) {
        return inline.slice(prefix.length);
    }

    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1] || fallback;
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
        return path.resolve(CANVASES_ROOT, relative);
    }

    return path.resolve(CANVAS_PATH, relative);
};

const CANVASES_ROOT = resolveConfigPath(argValue('--canvases', path.join(os.homedir(), 'Documents', 'LiquidOS')));
const CANVAS_TEMPLATE_ROOT = path.join(ROOT, 'skills', 'canvas-creator', 'templates');
const DEFAULT_CANVAS_PATH = path.join(CANVASES_ROOT, 'home');
let CANVAS_PATH = resolveConfigPath(argValue('--canvas', DEFAULT_CANVAS_PATH));
let INPUT_PATH = path.join(CANVAS_PATH, 'input.json');
let OUTPUT_PATH = path.join(CANVAS_PATH, 'output.json');
const AGENT_RUNTIME_ROOT = resolveConfigPath(argValue('--agent-runtime', process.env.LIQUIDOS_AGENT_RUNTIME_ROOT || path.join(os.homedir(), 'Library/Application Support/LiquidOS/AgentRuntime')));
const AGENT_RUNTIME_LOGS_DIR = path.join(AGENT_RUNTIME_ROOT, 'logs');
const HERMES_AGENT_LOG_PATH = path.join(AGENT_RUNTIME_LOGS_DIR, 'agent.log');
const HERMES_ERRORS_LOG_PATH = path.join(AGENT_RUNTIME_LOGS_DIR, 'errors.log');
const AGENTS_SOURCE_PATH = path.join(ROOT, 'skills', 'AGENTS.md');
const AGENTS_RUNTIME_PATH = path.join(AGENT_RUNTIME_ROOT, 'AGENTS.md');
const COMPONENT_CREATOR_SOURCE_PATH = path.join(ROOT, 'skills', 'component-creator');
const COMPONENT_CREATOR_RUNTIME_PATH = path.join(AGENT_RUNTIME_ROOT, 'component-creator');
const COMPONENT_GUIDE_PATH = path.join(COMPONENT_CREATOR_SOURCE_PATH, 'SKILL.md');
const CANVAS_CREATOR_SOURCE_PATH = path.join(ROOT, 'skills', 'canvas-creator');
const CANVAS_CREATOR_RUNTIME_PATH = path.join(AGENT_RUNTIME_ROOT, 'canvas-creator');
const LIVE_CANVAS_ROOT = String(process.env.LIQUIDOS_LIVE_CANVAS_ROOT || CANVASES_ROOT).trim() || CANVASES_ROOT;


const pathIsInside = (file, root) => {
    const relative = path.relative(root, file);
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

fs.mkdirSync(AGENT_RUNTIME_ROOT, { recursive: true });
fs.mkdirSync(AGENT_RUNTIME_LOGS_DIR, { recursive: true });

const materializeRuntimeFile = (sourcePath, destinationPath) => {
    if (!fs.existsSync(sourcePath)) {
        return false;
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    return true;
};

const materializeRuntimeDirectory = (sourcePath, destinationPath) => {
    if (!fs.existsSync(sourcePath)) {
        return false;
    }

    fs.rmSync(destinationPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
    return true;
};

const materializeAgentRuntimeFiles = () => {
    materializeRuntimeFile(AGENTS_SOURCE_PATH, AGENTS_RUNTIME_PATH);
    materializeRuntimeDirectory(COMPONENT_CREATOR_SOURCE_PATH, COMPONENT_CREATOR_RUNTIME_PATH);
    materializeRuntimeDirectory(CANVAS_CREATOR_SOURCE_PATH, CANVAS_CREATOR_RUNTIME_PATH);
};

process.env.LIQUIDOS_AGENT_RUNTIME_ROOT = AGENT_RUNTIME_ROOT;


materializeAgentRuntimeFiles();

fs.mkdirSync(CANVASES_ROOT, { recursive: true });

if (!fs.existsSync(path.join(CANVAS_PATH, 'input.json'))) {
    CANVAS_PATH = DEFAULT_CANVAS_PATH;
    INPUT_PATH = path.join(CANVAS_PATH, 'input.json');
    OUTPUT_PATH = path.join(CANVAS_PATH, 'output.json');
}
const PORT = Number.parseInt(argValue('--port', '3000'), 10);
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
let canvasesRootWatcher = null;
let watchTimer;
let graphWatchStarted = false;
let graphWatchKey = '';
let activeCanvasRuntime = null;
const componentServices = new Map();
let outputQueue = null;
let agentProviders = null;
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
    const activeProvider = agentProviders ? agentProviders.activeProvider() : null;
    const activeDebug = activeProvider && typeof activeProvider.currentDebug === 'function'
        ? activeProvider.currentDebug()
        : null;

    return {
        current: agentDebugState.current,
        lines: agentDebugState.lines.slice(-200),
        agentKind: agentProviders ? agentProviders.activeKind() : 'codex',
        active: activeProvider
            ? {
                ...(activeDebug || {}),
                kind: agentProviders.activeKind(),
                label: activeProvider.label || null
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

const parseProcessGroups = value => {
    const line = String(value || '')
        .split(/\r?\n/)
        .map(entry => entry.trim())
        .find(Boolean);

    if (!line) {
        return null;
    }

    const processGroups = JSON.parse(line).filter(entry => Number.isInteger(entry) && entry > 0);
    return processGroups.length ? processGroups : null;
};

const startComponentService = folder => {
    const startPath = path.join(folder, 'start.sh');
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

    componentServices.set(folder, { signature, processGroups: [] });

    const child = childProcess.spawn('/bin/bash', [startPath], {
        cwd: folder,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let started = false;

    const recordStarted = processGroups => {
        if (started || !processGroups) {
            return;
        }

        started = true;
        componentServices.set(folder, { signature, processGroups });
        logServer('component-service', 'started', { folder, processGroups });
    };

    child.stdout.on('data', chunk => {
        stdout += String(chunk);

        try {
            recordStarted(parseProcessGroups(stdout));
        } catch (error) {
            if (stdout.includes('\n')) {
                logHermesError('component-service', error, { folder, stdout: shortText(stdout), message: 'invalid process group list' });
            }
        }
    });
    child.stderr.on('data', chunk => {
        stderr += String(chunk);
        writeProcessOutput('[component-service]', chunk, process.stderr);
    });
    child.on('error', error => {
        componentServices.delete(folder);
        logHermesError('component-service', error, { folder, message: 'start failed' });
    });
    child.on('close', code => {
        if (!started) {
            try {
                recordStarted(parseProcessGroups(stdout));
            } catch (error) {
                logHermesError('component-service', error, { folder, stdout: shortText(stdout), message: 'invalid process group list' });
            }
        }

        if (code !== 0) {
            componentServices.delete(folder);
            logHermesError('component-service', new Error('start.sh exited ' + code), { folder, stderr: shortText(stderr) });
            return;
        }

        if (started) {
            logServer('component-service', 'exited', { folder });
            componentServices.delete(folder);
            return;
        }

        componentServices.delete(folder);
        logHermesError('component-service', new Error('start.sh exited without process groups'), { folder, stdout: shortText(stdout) });
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
    const desired = new Set(canvasGraph.componentServiceFolders());

    Array.from(componentServices.keys())
        .filter(folder => !desired.has(folder))
        .forEach(stopComponentService);

    desired.forEach(startComponentService);
};

const stopAllComponentServices = (forceImmediately = false) => {
    Array.from(componentServices.keys()).forEach(folder => stopComponentService(folder, forceImmediately));
};

configureHermesAgent({
    output: writeProcessOutput,
    status: setCurrentAgentDebug
});

configureCodexAgent({
    output: writeProcessOutput,
    status: setCurrentAgentDebug
});

configureClaudeCodeAgent({
    output: writeProcessOutput,
    status: setCurrentAgentDebug
});

agentProviders = createAgentProviders({
    agents: [
        HermesAgent(),
        CodexAgent(),
        ClaudeCodeAgent()
    ],
    workingDirectory: AGENT_RUNTIME_ROOT,
    onStatus: setCurrentAgentDebug
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
    canvasesRoot: CANVASES_ROOT,
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
            materializeAgentRuntimeFiles();
            this.started = true;
            ensureActiveCanvasFiles();
            ensureCanvasesGitRepo();
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
            if (canvasesRootWatcher) {
                canvasesRootWatcher.close();
                canvasesRootWatcher = null;
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
        return activeCanvasRuntime.start();
    }

    if (activeCanvasRuntime) {
        activeCanvasRuntime.stop();
    }

    activeCanvasRuntime = createCanvasRuntime(nextCanvasPath);
    return activeCanvasRuntime.start();
};

const callbackPromptText = job => job.prompt || job.request || '';

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
    root: ROOT,
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


const { ensureCanvasesGitRepo, commitCanvases, commitFailedCanvases, commitShutdownCanvases } = createGitTimeline({
    canvasesRoot: CANVASES_ROOT,
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

const buildAgentPrompt = job => agentProviders.preparePrompt(promptBuilder.buildJobPrompt(job));

const runQueuedAgentJob = (prompt, context = {}) =>
    agentProviders.runActive(prompt, context);

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

    try {
        const response = await runQueuedAgentJob(buildAgentPrompt({ ...job, id: jobId, componentPath }), {
            job: outputQueue.outputJobSummary({ ...job, id: jobId, componentPath, status: 'running' }),
            canvasPath: CANVAS_PATH,
            inputPath: INPUT_PATH,
            outputPath: OUTPUT_PATH,
            workingDirectory: AGENT_RUNTIME_ROOT,
            systemPromptPath: AGENTS_RUNTIME_PATH,
            canvasPath: CANVAS_PATH
        });

        if (/Blocked:|error=patch rejected|not writable in this environment|writing outside of the project/i.test(response)) {
            throw new Error('Agent failed the live canvas write check and the test was stopped early.');
        }

        logServer('agent', 'agent job returned', {
            jobId,
            response: shortText(response)
        });

        canvasGraph.validateCanvasConfig();

        if (componentPath) {
            canvasGraph.validateComponentFile(componentPath);
        }
        await outputQueue.updateOutputJob(jobId, {
            status: 'done',
            completedAt: new Date().toISOString()
        });
        broadcastQueueState();

        commitCanvases({ ...job, id: jobId });

        logServer('queue', 'job marked done', {
            jobId,
            lane: laneKey,
            durationMs: Date.now() - startedAt
        });
    } catch (error) {
        commitFailedCanvases({ ...job, id: jobId }, error);
        canvasGraph.validateCanvasConfig();
        await outputQueue.updateOutputJob(jobId, {
            status: 'failed',
            failedAt: new Date().toISOString(),
            error: error.message
        });
        broadcastQueueState();
        logServer('queue', 'job marked failed', {
            jobId,
            lane: laneKey,
            durationMs: Date.now() - startedAt,
            error: error.message
        });

    } finally {
        if (activeOutputJob && activeOutputJob.id === jobId) {
            activeOutputJob = null;
        }
    }
};

outputQueue.setProcessJob(processOutputJob);

const canvasName = canvasPath =>
    path.relative(CANVASES_ROOT, canvasPath) || path.basename(canvasPath);

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

const queueStatePayload = componentPath => ({
    type: 'queue-status',
    state: outputQueue.currentBusyState(componentPath)
});

const broadcastQueueState = (componentPath = '') => {
    broadcast(queueStatePayload(componentPath));
};

const scheduleWatchRefresh = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
        try {
            canvasGraph.renderedInput();
            refreshGraphWatchers();
            reconcileComponentServices();
        } catch (error) {
            logHermesError('watch', error, { message: 'watch error' });
            broadcast();
            return;
        }

        broadcast();
    }, 50);
};

const scheduleCanvasesRootRefresh = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
        try {
            watchCanvasesRoot();
        } catch (error) {
            logHermesError('watch', error, { message: 'canvases root watch error' });
            broadcast({ type: 'canvases-changed' });
            return;
        }

        broadcast({ type: 'canvases-changed' });
    }, 50);
};

const watchCanvasesRoot = () => {
    if (canvasesRootWatcher) {
        canvasesRootWatcher.close();
        canvasesRootWatcher = null;
    }

    canvasesRootWatcher = fs.watch(CANVASES_ROOT, { persistent: false }, scheduleCanvasesRootRefresh);
};

const safeWatchEntries = () =>
    canvasGraph.watchedPaths()
        .filter(entry => fs.existsSync(entry.path))
        .filter(entry => {
            try {
                return path.relative(CANVAS_PATH, entry.path) === ''
                    || (!path.relative(CANVAS_PATH, entry.path).startsWith('..') && !path.isAbsolute(path.relative(CANVAS_PATH, entry.path)));
            } catch (error) {
                return false;
            }
        });

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
            watchers.push(fs.watch(entry.path, { persistent: false, recursive: Boolean(entry.recursive) }, scheduleWatchRefresh));
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
            send(res, 200, JSON.stringify(agentProviders.probe({ checkInstalled: false })), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/agent/select') {
            const body = JSON.parse(await readBody(req));
            const result = agentProviders.setActiveKind(body.kind);

            if (!result.ok) {
                send(res, result.statusCode, JSON.stringify({ error: result.error }), 'application/json; charset=utf-8');
                return;
            }

            if (outputQueue) {
                outputQueue.feedHermesOutput();
            }

            broadcast({
                type: 'agent-mode',
                agentKind: agentProviders.activeKind()
            });

            send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
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
            send(res, 200, JSON.stringify(canvasGraph.renderedInput()), 'application/json; charset=utf-8');
            startGraphWatchAfterFirstInput();
            return;
        }

        if (req.method === 'GET' && url.pathname === '/canvases') {
            send(res, 200, JSON.stringify({
                current: canvasName(CANVAS_PATH),
                currentPath: CANVAS_PATH,
                canvases: canvasFiles.availableCanvases()
            }), 'application/json; charset=utf-8');
            if (!canvasesRootWatcher) {
                setImmediate(watchCanvasesRoot);
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
            commitCanvases({ scope: CANVAS_PATH, prompt: 'create canvas: ' + name });
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


        const sharedAsset = url.pathname.match(/^\/(layouts|transitions)\/([A-Za-z0-9._-]+\.json)$/);

        if (req.method === 'GET' && sharedAsset) {
            const resolvedPath = path.resolve(CANVAS_PATH, sharedAsset[1], sharedAsset[2]);
            const canvasBoundary = CANVAS_PATH + path.sep;

            if (!resolvedPath.startsWith(canvasBoundary)) {
                send(res, 403, 'Forbidden');
                return;
            }

            if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
                send(res, 404, 'Not found');
                return;
            }

            streamFile(req, res, resolvedPath, 'application/json; charset=utf-8');
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

        streamFile(
            req,
            res,
            file,
            path.basename(file) === 'index.html' ? 'text/html; charset=utf-8' : undefined
        );
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
    return commitShutdownCanvases(activeOutputJob || { scope: CANVAS_PATH, prompt: '(no active prompt)' }, reason);
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
    console.log('Build: ' + SERVER_BUILD);
    console.log('Server at http://localhost:' + PORT);
    console.log('Canvas: ' + CANVAS_PATH);
    console.log('Input: ' + INPUT_PATH);
    console.log('Output: ' + OUTPUT_PATH);
});
