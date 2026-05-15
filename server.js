const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createGitTimeline } = require('./gitTimeline');
const { createHermesBootstrap } = require('./hermesBootstrap');
const { createHermesHost } = require('./hermesHost');
const { createAgentProviders } = require('./agentProviders');
const { createCanvasFiles } = require('./canvasFiles');
const { createCanvasGraph } = require('./canvasGraph');
const { createOutputQueue } = require('./outputQueue');
const { createPromptBuilder } = require('./promptBuilder');
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

const CANVASES_ROOT = resolveConfigPath(argValue('--canvases', path.join(os.homedir(), 'Documents', 'LiquidOS')));
const CANVAS_TEMPLATE_ROOT = path.join(ROOT, 'templates', 'canvas');
const DEFAULT_CANVAS_PATH = path.join(CANVASES_ROOT, 'home');
let CANVAS_PATH = resolveConfigPath(argValue('--canvas', DEFAULT_CANVAS_PATH));
let INPUT_PATH = path.join(CANVAS_PATH, 'input.json');
let OUTPUT_PATH = path.join(CANVAS_PATH, 'output.json');
const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), 'Library/Application Support/LiquidOS/Hermes');
const HERMES_LOGS_DIR = path.join(HERMES_HOME, 'logs');
const HERMES_AGENT_LOG_PATH = path.join(HERMES_LOGS_DIR, 'agent.log');
const HERMES_ERRORS_LOG_PATH = path.join(HERMES_LOGS_DIR, 'errors.log');
const HERMES_SOURCE_SOUL_PATH = path.join(ROOT, '.hermes', 'SOUL.md');
const HERMES_RUNTIME_SOUL_PATH = path.join(HERMES_HOME, 'SOUL.md');

fs.mkdirSync(HERMES_LOGS_DIR, { recursive: true });

if (fs.existsSync(HERMES_SOURCE_SOUL_PATH)) {
    fs.mkdirSync(HERMES_HOME, { recursive: true });
    fs.copyFileSync(HERMES_SOURCE_SOUL_PATH, HERMES_RUNTIME_SOUL_PATH);
}

fs.mkdirSync(CANVASES_ROOT, { recursive: true });

if (!fs.existsSync(path.join(CANVAS_PATH, 'input.json'))) {
    CANVAS_PATH = DEFAULT_CANVAS_PATH;
    INPUT_PATH = path.join(CANVAS_PATH, 'input.json');
    OUTPUT_PATH = path.join(CANVAS_PATH, 'output.json');
}
const PORT = Number.parseInt(argValue('--port', '3000'), 10);
const commandExists = command => {
    if (!command) {
        return false;
    }

    if (path.isAbsolute(command)) {
        return fs.existsSync(command);
    }

    const result = spawnSync('which', [command], {
        cwd: ROOT,
        env: process.env,
        encoding: 'utf8'
    });

    return result.status === 0;
};

const resolveHermesCommand = () => {
    const explicitCommand = argValue('--agent', argValue('--hermes-command', '')).trim();

    if (explicitCommand) {
        return explicitCommand;
    }

    if (commandExists('hermes')) {
        return 'hermes';
    }

    const bundledHermes = String(process.env.LIQUIDOS_BUNDLED_HERMES || '').trim();

    if (bundledHermes && commandExists(bundledHermes)) {
        return bundledHermes;
    }

    return 'hermes';
};

const HERMES_AGENT_COMMAND = resolveHermesCommand();
const AGENT_SOURCE = path.isAbsolute(HERMES_AGENT_COMMAND) ? 'bundled' : 'global';
const AGENT_MODE = argValue('--agent-mode', argValue('--hermes-mode', 'oneshot')).trim() || 'oneshot';
const AGENT_ARGS = argValue('--agent-args', argValue('--hermes-args', '')).split(' ').filter(Boolean);
const AGENT_TIMEOUT_MS = Number.parseInt(argValue('--agent-timeout-ms', '300000'), 10);
const RUNTIME_KIND = String(process.env.LIQUIDOS_RUNTIME_KIND || (process.env.LIQUIDOS_NATIVE === '1' ? 'mac-app' : 'standalone')).trim() || 'standalone';
const LIVE_CANVAS_ROOT = String(process.env.LIQUIDOS_LIVE_CANVAS_ROOT || CANVASES_ROOT).trim() || CANVASES_ROOT;
const BASE_AGENT_PROMPT = argValue('--agent-prompt', argValue('--hermes-prompt', ''));
const RUNTIME_AGENT_PROMPT = [
    BASE_AGENT_PROMPT,
    `Runtime: ${RUNTIME_KIND === 'mac-app' ? 'LiquidOS Mac app' : 'standalone repo server'}`,
    `Live canvas root: ${LIVE_CANVAS_ROOT}`
].filter(Boolean).join('\n');
const hermesBootstrap = createHermesBootstrap({
    root: ROOT,
    agentCommand: HERMES_AGENT_COMMAND
});

const clients = new Set();
const debugClients = new Set();
let watchers = [];
let canvasesRootWatcher = null;
let watchTimer;
let activeCanvasRuntime = null;
let hermesHost = null;
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

const pushAgentDebugLine = (label, chunk) => {
    String(chunk)
        .replace(/\r\n/g, '\n')
        .split('\n')
        .forEach(line => {
            const text = stripAnsi(String(line).split('\r').pop()).trimEnd();

            if (!text.trim()) {
                return;
            }

            agentDebugState.lines.push({
                at: new Date().toISOString(),
                label,
                text
            });

            if (agentDebugState.lines.length > 300) {
                agentDebugState.lines.splice(0, agentDebugState.lines.length - 300);
            }
        });
};

const setCurrentAgentDebug = next => {
    agentDebugState.current = {
        ...next,
        source: next.source || AGENT_SOURCE,
        at: new Date().toISOString()
    };
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
    fs.appendFileSync(file, line + '\n');
};

const stripAnsiForLog = value =>
    String(value || '')
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
        .replace(/\r/g, '');

const writeProcessOutput = (label, chunk, stream = process.stdout) => {
    const normalized = String(chunk).replace(/\r\n/g, '\n');

    normalized.split(/(?<=\n)/).forEach(line => {
        if (!line.length) {
            return;
        }

        const cleanLine = stripAnsiForLog(line);

        if (!cleanLine.trim()) {
            return;
        }

        stream.write(`${label} ${line}`);
        pushAgentDebugLine(label, line);
        appendHermesLog(HERMES_AGENT_LOG_PATH, `${label} ${cleanLine.trimEnd()}`);
        emitDebugEvent({ type: 'debug-line', line: agentDebugState.lines[agentDebugState.lines.length - 1] || null });
    });
};

const shortText = value => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > 160 ? text.slice(0, 157) + '...' : text;
};
const ENABLED_HERMES_TOOLSETS = (() => {
    try {
        const result = spawnSync(HERMES_AGENT_COMMAND, ['plugins', 'list'], {
            cwd: ROOT,
            env: process.env,
            encoding: 'utf8',
            maxBuffer: 2_000_000
        });

        if (result.status !== 0) {
            return [];
        }

        return Array.from(
            new Set(
                String(result.stdout || '')
                    .split(/\r?\n/)
                    .flatMap(line => {
                        const match = line.match(/^\s*│\s*([^│]+?)\s*│\s*enabled\s*│/);
                        return match ? [match[1].trim()] : [];
                    })
                    .filter(Boolean)
            )
        );
    } catch (error) {
        logHermesError('hermes-host', error, { message: 'toolset discovery failed' });
        return [];
    }
})();

hermesHost = createHermesHost({
    root: ROOT,
    canvasesRoot: CANVASES_ROOT,
    agentCommand: HERMES_AGENT_COMMAND,
    agentArgs: AGENT_ARGS,
    enabledToolsets: ENABLED_HERMES_TOOLSETS,
    hermesBootstrap,
    getCanvasPath: () => CANVAS_PATH,
    getInputPath: () => INPUT_PATH,
    getOutputPath: () => OUTPUT_PATH,
    logServer,
    logHermesError,
    shortText,
    setCurrentAgentDebug,
    writeProcessOutput,
    pty
});

agentProviders = createAgentProviders({
    root: ROOT,
    canvasesRoot: CANVASES_ROOT,
    hermesCommand: HERMES_AGENT_COMMAND,
    hermesBootstrap,
    hermesHost,
    commandExists,
    logServer,
    shortText,
    setCurrentAgentDebug,
    writeProcessOutput,
    pty,
    agentTimeoutMs: AGENT_TIMEOUT_MS
});

const sleepSync = ms => {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, ms);
};

const readJson = (file, retries = 8, delayMs = 25) => {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            lastError = error;

            const transientParseError =
                error instanceof SyntaxError
                || /Unexpected end of JSON input/.test(error.message)
                || /Expected ',' or '}' after property value/.test(error.message);

            if (!transientParseError || attempt === retries || !fs.existsSync(file)) {
                throw error;
            }

            sleepSync(delayMs);
        }
    }

    throw lastError;
};

const writeJson = (file, value) => {
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, file);
};

const canvasFiles = createCanvasFiles({
    fs,
    canvasesRoot: CANVASES_ROOT,
    canvasTemplateRoot: CANVAS_TEMPLATE_ROOT,
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
            this.started = true;
            ensureActiveCanvasFiles();
            ensureCanvasesGitRepo();
            outputQueue.normalizeOutputJobs();
            outputQueue.clearActiveLanes();
            agentProviders.startActiveCanvas(this.canvasPath);
            watchCanvasesRoot();
            watchGraph();
            outputQueue.feedHermesOutput();
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
        return resolveCanvasReference(scope) === CANVAS_PATH;
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


const { ensureCanvasesGitRepo, commitCanvases } = createGitTimeline({
    canvasesRoot: CANVASES_ROOT,
    currentCanvasPath: () => CANVAS_PATH,
    logServer
});

const promptBuilder = createPromptBuilder({
    basePrompt: RUNTIME_AGENT_PROMPT,
    getCanvasPath: () => CANVAS_PATH,
    outputJobKey: job => outputQueue.outputJobKey(job),
    callbackPromptText,
    componentScopePath: canvasGraph.componentScopePath,
    resolveCanvasReference
});

const spawnHermesPromptProcess = (prompt, context = {}) =>
    new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const outputLabel = 'hermes-prompt-process';
        const liveArgs = [...hermesBootstrap.selectedHermesLaunchArgs(), '-z', prompt, ...AGENT_ARGS];

        logServer('agent', 'starting prompt process', {
            command: HERMES_AGENT_COMMAND,
            args: liveArgs,
            canvas: CANVAS_PATH,
            job: context.job || null
        });
        logServer('agent', 'sending prompt to Hermes prompt process', {
            canvas: CANVAS_PATH,
            prompt: shortText(prompt),
            promptChars: String(prompt || '').length,
            job: context.job || null
        });

        const proc = pty.spawn(
            HERMES_AGENT_COMMAND,
            liveArgs,
            {
                name: 'xterm-color',
                cols: 160,
                rows: 50,
                cwd: ROOT,
                env: {
                    ...process.env,
                    ...hermesBootstrap.selectedHermesLaunchEnv(),
                    LIVE_EDIT_OUTPUT_PATH: OUTPUT_PATH,
                    LIVE_EDIT_INPUT_PATH: INPUT_PATH,
                    LIVE_EDIT_CANVAS_PATH: CANVAS_PATH
                }
            }
        );

        setCurrentAgentDebug({
            kind: 'prompt-process',
            label: 'Hermes prompt process',
            command: HERMES_AGENT_COMMAND,
            status: 'running',
            job: context.job || null,
            pid: proc.pid || null,
            startedAt: new Date().toISOString(),
            provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
            model: hermesBootstrap.currentHermesBootstrapState().model || null
        });

        logServer('agent', 'spawned prompt process', {
            pid: proc.pid,
            job: context.job || null
        });

        const timeout = setTimeout(() => {
            timedOut = true;
            logServer('agent', 'timeout; sending SIGTERM', {
                pid: proc.pid,
                timeoutMs: AGENT_TIMEOUT_MS,
                job: context.job || null
            });
            proc.kill('SIGTERM');
        }, AGENT_TIMEOUT_MS);

        proc.onData(chunk => {
            stdout += chunk;
            writeProcessOutput(outputLabel, chunk);
        });

        proc.onExit(({ exitCode, signal }) => {
            clearTimeout(timeout);
            logServer('agent', 'prompt process closed', {
                code: exitCode,
                signal,
                timedOut,
                stdoutBytes: Buffer.byteLength(stdout),
                stderrBytes: Buffer.byteLength(stderr),
                job: context.job || null
            });
            if (timedOut) {
                setCurrentAgentDebug({
                    kind: 'idle',
                    label: 'Idle',
                    command: HERMES_AGENT_COMMAND,
                    status: 'timed out',
                    provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
                    model: hermesBootstrap.currentHermesBootstrapState().model || null
                });
                reject(new Error('Agent timed out after ' + AGENT_TIMEOUT_MS + 'ms'));
                return;
            }

            if (exitCode !== 0) {
                setCurrentAgentDebug({
                    kind: 'idle',
                    label: 'Idle',
                    command: HERMES_AGENT_COMMAND,
                    status: 'failed',
                    exitCode,
                    provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
                    model: hermesBootstrap.currentHermesBootstrapState().model || null
                });
                reject(new Error('Agent exited with code ' + exitCode + (stderr.trim() ? ': ' + stderr.trim() : '')));
                return;
            }

            setCurrentAgentDebug({
                kind: 'idle',
                label: 'Idle',
                command: HERMES_AGENT_COMMAND,
                status: 'waiting',
                provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
                model: hermesBootstrap.currentHermesBootstrapState().model || null
            });

            resolve(stdout.trim());
        });

        proc.on('error', error => {
            clearTimeout(timeout);
            logServer('agent', 'prompt process error', {
                error: error.message,
                job: context.job || null
            });
            setCurrentAgentDebug({
                kind: 'idle',
                label: 'Idle',
                command: HERMES_AGENT_COMMAND,
                status: 'error',
                error: error.message,
                provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
                model: hermesBootstrap.currentHermesBootstrapState().model || null
            });
            reject(error);
        });
    });

const runQueuedAgentJob = (prompt, context = {}) =>
    agentProviders.runActive(prompt, context);

const processOutputJob = async job => {
    const jobId = job.id || 'job-' + Date.now();
    const componentPath = job.componentPath ? resolveCanvasReference(job.componentPath) : null;
    const laneKey = outputQueue.outputJobKey(job);
    const isCanvasJob = isCanvasScope(job.scope) || laneKey === 'canvas';
    const startedAt = Date.now();

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
        const response = await runQueuedAgentJob(promptBuilder.buildAgentJobPrompt({ ...job, id: jobId, componentPath }), {
            job: outputQueue.outputJobSummary({ ...job, id: jobId, componentPath, status: 'running' }),
            canvasPath: CANVAS_PATH,
            inputPath: INPUT_PATH,
            outputPath: OUTPUT_PATH
        });

        if (/Blocked:|error=patch rejected|not writable in this environment|writing outside of the project/i.test(response)) {
            throw new Error('Agent failed the live canvas write check and the test was stopped early.');
        }

        logServer('agent', 'agent job returned', {
            jobId,
            response: shortText(response)
        });

        canvasGraph.validateCanvasConfig();

        if (isCanvasJob) {
            canvasGraph.validateComponentFiles(canvasGraph.inputEntries().map(entry => entry.componentPath));
        } else if (componentPath) {
            canvasGraph.validateComponentFile(componentPath);
        } else {
            throw new Error('Component job is missing a componentPath');
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

        setImmediate(() => {
            process.exit(1);
        });
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

const emitDebugEvent = payload => {
    const message = JSON.stringify(payload);
    debugClients.forEach(res => {
        res.write('event: ' + payload.type + '\n');
        res.write('data: ' + message + '\n\n');
    });
};

const scheduleWatchRefresh = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
        try {
            watchGraph();
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

const watchGraph = () => {
    watchers.forEach(watcher => watcher.close());
    watchers = [];

    canvasGraph.watchedFiles().forEach(file => {
        watchers.push(fs.watch(file, { persistent: false }, scheduleWatchRefresh));
    });
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
    const resolvedScope = scope ? resolveCanvasReference(scope) : '';
    const leaf = resolvedScope ? canvasGraph.findLeafComponentByScope(resolvedScope) : null;
    const isCanvasPrompt = !scope || resolvedScope === CANVAS_PATH || (!leaf && resolvedScope === CANVAS_PATH);

    if (!prompt) {
        throw new Error('Prompt requires prompt text');
    }

    if (isCanvasPrompt) {
        logServer('callback', 'received canvas prompt', {
            canvas: CANVAS_PATH,
            scope: resolvedScope || CANVAS_PATH,
            prompt
        });
        await outputQueue.appendOutputJob({
            id: 'output-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            scope: CANVAS_PATH,
            status: 'pending',
            createdAt: new Date().toISOString(),
            componentKey: 'canvas',
            prompt
        });
        return;
    }

    if (!leaf) {
        throw new Error('Prompt requires a valid scope and prompt');
    }

    logServer('callback', 'received component prompt', {
        canvas: CANVAS_PATH,
        scope: resolvedScope,
        prompt,
        componentPath: leaf.componentPath || null,
        file: leaf.component.file || null
    });
    await outputQueue.appendOutputJob({
        id: 'output-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        scope: leaf.componentPath || leaf.component.file || null,
        status: 'pending',
        createdAt: new Date().toISOString(),
        componentKey: leaf.componentPath || leaf.component.file || null,
        file: leaf.component.file || null,
        resources: canvasGraph.componentResources(leaf.component),
        data: leaf.component.data || null,
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
            req.on('close', () => debugClients.delete(res));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/agents/probe') {
            send(res, 200, JSON.stringify({
                ...hermesBootstrap.probeLocalAgents(),
                agentKind: agentProviders.activeKind(),
                agentChoices: agentProviders.availableKinds()
            }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/agent/select') {
            const body = JSON.parse(await readBody(req));
            const result = agentProviders.setActiveKind(body.kind, CANVAS_PATH);

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
                hermes: hermesBootstrap.currentHermesBootstrapState(),
                canvas: canvasName(CANVAS_PATH)
            }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/agents/select') {
            const body = JSON.parse(await readBody(req));
            const result = hermesBootstrap.selectHermesBackend(body.id);

            if (!result.ok) {
                send(res, result.statusCode, JSON.stringify({ error: result.error }), 'application/json; charset=utf-8');
                return;
            }

            hermesHost.startCanvasHermesHost(CANVAS_PATH);
            outputQueue.feedHermesOutput();
            broadcast();
            send(res, 200, JSON.stringify({
                ok: true,
                hermes: result.hermes,
                selected: result.selected
            }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'GET' && url.pathname === '/input') {
            send(res, 200, JSON.stringify(canvasGraph.renderedInput()), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'GET' && url.pathname === '/status') {
            const componentPath = url.searchParams.get('componentPath') || '';
            send(res, 200, JSON.stringify(outputQueue.currentBusyState(componentPath)), 'application/json; charset=utf-8');
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
            commitCanvases({ scope: 'canvas', prompt: 'create canvas: ' + name });
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
            const resolvedPath = resolveConfigPath(path.join(ROOT, sharedAsset[1], sharedAsset[2]));

            if (!resolvedPath.startsWith(ROOT + path.sep) && resolvedPath !== ROOT) {
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

            streamFile(req, res, component.file, component.type);
            return;
        }

        const inputResource = url.pathname.match(/^\/input\/(\d+)\/resources\/(.+)$/);

        if (req.method === 'GET' && inputResource) {
            const component = canvasGraph.leafComponents()[Number(inputResource[1])]?.component;
            const name = decodeURIComponent(inputResource[2]);
            const resource = component && canvasGraph.componentResources(component)[name];

            if (!resource?.path) {
                send(res, 404, 'Input resource not found');
                return;
            }

            streamFile(req, res, resource.path, resource.mime || resource.type);
            return;
        }

        const componentFile = url.pathname.match(/^\/component\/(.+)\/file$/);

        if (req.method === 'GET' && componentFile) {
            const componentPath = decodeURIComponent(componentFile[1]);
            const component = canvasGraph.findLeafComponentByScope(componentPath)?.component;

            if (!component?.file) {
                send(res, 404, 'Component file not found');
                return;
            }

            streamFile(req, res, component.file, component.type);
            return;
        }

        const componentResource = url.pathname.match(/^\/component\/(.+)\/resources\/(.+)$/);

        if (req.method === 'GET' && componentResource) {
            const componentPath = decodeURIComponent(componentResource[1]);
            const component = canvasGraph.findLeafComponentByScope(componentPath)?.component;
            const name = decodeURIComponent(componentResource[2]);
            const resource = component && canvasGraph.componentResources(component)[name];

            if (!resource?.path) {
                send(res, 404, 'Component resource not found');
                return;
            }

            streamFile(req, res, resource.path, resource.mime || resource.type);
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

const shutdownCanvasRuntime = () => {
    if (activeCanvasRuntime) {
        activeCanvasRuntime.stop();
        activeCanvasRuntime = null;
        return true;
    }

    return hermesHost.stopCanvasHermesHost();
};

process.on('exit', shutdownCanvasRuntime);
process.on('SIGINT', () => {
    shutdownCanvasRuntime();
    process.exit(130);
});
process.on('SIGTERM', () => {
    shutdownCanvasRuntime();
    process.exit(143);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('Build: ' + SERVER_BUILD);
    console.log('Server at http://localhost:' + PORT);
    console.log('Canvas: ' + CANVAS_PATH);
    console.log('Input: ' + INPUT_PATH);
    console.log('Output: ' + OUTPUT_PATH);
});
