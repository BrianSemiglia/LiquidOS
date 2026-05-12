const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createGitTimeline } = require('./gitTimeline');
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

const resolveConfigPath = value =>
    path.isAbsolute(value) ? value : path.resolve(ROOT, value);

const resolveCanvasReference = value => {
    if (!value) {
        return value;
    }

    if (path.isAbsolute(value)) {
        return value;
    }

    const canvasRelative = path.resolve(CANVAS_PATH, value);

    if (fs.existsSync(canvasRelative)) {
        return canvasRelative;
    }

    return resolveFromRoot(value);
};

const relativeCanvasPath = value =>
    path.relative(CANVAS_PATH, value).split(path.sep).join('/');

const componentScopePath = componentPath =>
    relativeCanvasPath(path.dirname(componentPath));

const CANVASES_ROOT = resolveConfigPath(argValue('--canvases', path.join(ROOT, 'canvases')));
const CANVAS_TEMPLATE_ROOT = path.join(ROOT, 'templates', 'canvas');
const DEFAULT_CANVAS_PATH = path.join(CANVASES_ROOT, 'home');
let CANVAS_PATH = resolveConfigPath(argValue('--canvas', DEFAULT_CANVAS_PATH));
let INPUT_PATH = path.join(CANVAS_PATH, 'input.json');
let OUTPUT_PATH = path.join(CANVAS_PATH, 'output.json');
let DELTAS_PATH = path.join(CANVAS_PATH, 'deltas.json');

const copyTemplateDirectory = (source, target) => {
    fs.mkdirSync(target, { recursive: true });

    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (entry.name === '.gitkeep') {
            continue;
        }

        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);

        if (entry.isDirectory()) {
            copyTemplateDirectory(sourcePath, targetPath);
        } else if (entry.isFile() && !fs.existsSync(targetPath)) {
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
};

const writeDefaultFile = (filePath, contents) => {
    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents);
    }
};

const ensureCanvasDefaults = name => {
    const canvasPath = path.join(CANVASES_ROOT, name);

    fs.mkdirSync(canvasPath, { recursive: true });

    if (fs.existsSync(CANVAS_TEMPLATE_ROOT)) {
        copyTemplateDirectory(CANVAS_TEMPLATE_ROOT, canvasPath);
    }

    fs.mkdirSync(path.join(canvasPath, 'components'), { recursive: true });

    writeDefaultFile(
        path.join(canvasPath, 'input.json'),
        JSON.stringify({ components: [], css: 'body{background:#0b1120}' }, null, 2) + '\n'
    );
    writeDefaultFile(path.join(canvasPath, 'output.json'), '[]\n');
    writeDefaultFile(path.join(canvasPath, 'deltas.json'), '[]\n');
    writeDefaultFile(
        path.join(canvasPath, 'canvas.html'),
        `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blank Canvas</title>
  <style>
    html, body {
      margin: 0;
      min-height: 100%;
      background: #0b1120;
    }
  </style>
</head>
<body></body>
</html>
`
    );

    return canvasPath;
};

fs.mkdirSync(CANVASES_ROOT, { recursive: true });
ensureCanvasDefaults('home');

if (!fs.existsSync(path.join(CANVAS_PATH, 'input.json'))) {
    CANVAS_PATH = DEFAULT_CANVAS_PATH;
    INPUT_PATH = path.join(CANVAS_PATH, 'input.json');
    OUTPUT_PATH = path.join(CANVAS_PATH, 'output.json');
    DELTAS_PATH = path.join(CANVAS_PATH, 'deltas.json');
}
const PORT = Number.parseInt(argValue('--port', '3000'), 10);
const AGENT_COMMAND = argValue('--agent', argValue('--hermes-command', 'hermes'));
const AGENT_ARGS = argValue('--agent-args', argValue('--hermes-args', '--oneshot')).split(' ').filter(Boolean);
const AGENT_TIMEOUT_MS = Number.parseInt(argValue('--agent-timeout-ms', '300000'), 10);
const AGENT_PROMPT = argValue('--agent-prompt', argValue('--hermes-prompt', [
    'You are LiquidOS, a just-in-time operating system.',
    'Act as a domain/product assistant first and a code/JSON editor second. Treat JSON, file paths, schemas, and implementation details as storage mechanics, not the subject of the task, unless the user explicitly asks for debugging, implementation, or code review.',
    'Reason from the user-facing meaning of canvases and components. When the user asks for todos, summaries, dashboards, cleanup, or organization, extract actionable domain content from visible component titles, text, state, prompts, and represented files; do not create JSON reviews, schema reviews, file audits, or Kanban boards unless explicitly requested.',
    'Prefer updating existing user-facing components that match the request. Create new components only when no suitable component exists or the user asks for a new view.',
    'Prioritize speed and simple solutions unless the task is clearly complex. Your output drives the UI, so faster responses improve the user experience; avoid unnecessary reasoning for straightforward changes.',
    'For component-scoped requests, edit only the allowed component JSON file, the allowed canvas config file, and, when the user request explicitly concerns the represented file, the allowed represented file or resources.',
    'For canvas-scoped requests, edit the allowed canvas config file and any listed component JSON files needed to satisfy the request.',
    'Treat callbacks as per-component lanes: one component may block its own lane, but one component must not block another; dispatch work to separate component workers when possible.',
    'Prefer component JSON for local UI changes; prefer represented files for content/file changes.',
    'Prefer the canvas config file for layout changes that affect the outer canvas, such as maximize, minimize, hide, show, ordering, or canvas CSS.',
    'Preserve valid JSON and existing component fields unless the request requires changing them.',
    'When editing the canvas config, preserve valid JSON and the existing components list unless the request requires changing it.',
    'When editing component HTML, keep all HTML inside the "html" string valid.',
    'If adding JavaScript to component HTML, place complete <script> tags after the component markup.',
    'When adding a control to a component for an agent-performed action, wire it with data-live-prompt containing the follow-up request; do not implement the action locally unless the user explicitly asks for local behavior.',
    'Label controls as normal user-facing actions. Avoid meta words like realize, materialize, make, generate, agent, prompt, or fulfill unless the user explicitly asked for that wording.',
    'For component-scoped callbacks, the target component is relevant unless the request clearly identifies another allowed component. For canvas-scoped callbacks, inspect the current canvas config and allowed component files to choose relevant components; use selected components as hints only when they are supplied.',
    'Second, after the work completes, write the resolved or failed state to disk and unlock controls that should be usable again. Do not defer the loading-state write until the final answer.',
    'Do not edit output.json, deltas.json, server.js, or files outside the allowed paths.',
    'When you obtain useful output, write it into the canvas by updating the allowed canvas config or component JSON. Do not treat opening a browser, reading a page, or reporting in chat as completion unless the canvas is also updated.',
    'When you want to communicate results or messages to the user, spawn a new component JSON file in the instance components/ directory, then add its path to input.json so it appears on the canvas.',
    'For research/search tasks, add or update a component that shows the results, sources, links, and next actions in the canvas.',
    'After editing a component, parse the component JSON and syntax-check embedded script blocks.',
    'After editing the canvas config, parse the canvas config JSON.',
    'The user ONLY sees the canvas - they do not see chat messages. ALL communication must be rendered as components.',
    'Reply with a one-line summary.',
    'The canvases directory is under Git control as a read-only activity timeline for the agent. Commits are made automatically by the server after successful work. You may inspect Git history to answer questions like when something happened, what changed, or what the user may have been trying to do, but do not create, amend, revert, reset, rebase, or otherwise mutate Git history.'
].join(' ')));

const clients = new Set();
let watchers = [];
let watchTimer;
let activeCanvasHermes = null;
let activeCanvasRuntime = null;
let outputDispatchTimer = null;
let outputDispatching = false;
const activeOutputKeys = new Set();


const localAgentDefinitions = [
    {
        id: 'claude-code',
        label: 'Claude Code',
        command: 'claude',
        installCommand: 'curl -fsSL https://claude.ai/install.sh | bash && claude'
    },
    {
        id: 'codex',
        label: 'Codex',
        command: 'codex',
        installCommand: 'npm install -g @openai/codex && codex'
    }
];

const commandExists = command =>
    spawnSync('which', [command], {
        cwd: ROOT,
        env: process.env,
        encoding: 'utf8'
    }).status === 0;

const probeLocalAgents = () => {
    if (!commandExists(AGENT_COMMAND)) {
        return {
            hermes: {
                installed: false,
                usable: false,
                command: AGENT_COMMAND
            },
            agents: []
        };
    }

    return {
        hermes: {
            installed: true,
            usable: true,
            command: AGENT_COMMAND
        },
        agents: [
            {
                id: 'hermes',
                label: 'Hermes',
                command: AGENT_COMMAND,
                installed: true,
                usable: true
            }
        ]
    };
};

const logServer = (area, message, details = null) => {
    const suffix = details ? ' ' + JSON.stringify(details) : '';
    console.log(`[${new Date().toISOString()}] [${area}] ${message}${suffix}`);
};

const writeProcessOutput = (label, chunk, stream = process.stdout) => {
    String(chunk).split(/(?<=\n)/).forEach(line => {
        if (line.length) {
            stream.write(`${label} ${line}`);
        }
    });
};

const shortText = value => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > 160 ? text.slice(0, 157) + '...' : text;
};
const ENABLED_HERMES_TOOLSETS = (() => {
    try {
        const result = spawnSync(AGENT_COMMAND, ['plugins', 'list'], {
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
        console.error('[hermes-host] toolset discovery failed:', error.message);
        return [];
    }
})();

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const outputLockPath = () => OUTPUT_PATH + '.lock';

const withOutputLock = async task => {
    const lockFile = outputLockPath();
    let lockFd = null;

    while (lockFd === null) {
        try {
            lockFd = fs.openSync(lockFile, 'wx');
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }

            try {
                const stat = fs.statSync(lockFile);
                if (Date.now() - stat.mtimeMs > 10_000) {
                    fs.unlinkSync(lockFile);
                }
            } catch (_) {
                // Ignore lock cleanup errors and retry.
            }

            await sleep(25);
        }
    }

    try {
        return await task();
    } finally {
        try {
            fs.closeSync(lockFd);
        } catch (_) {
            // Ignore close errors on shutdown paths.
        }

        try {
            fs.unlinkSync(lockFile);
        } catch (_) {
            // Ignore cleanup failures if another process already cleared it.
        }
    }
};

const ensureActiveCanvasFiles = () => {
    if (!fs.existsSync(INPUT_PATH)) {
        throw new Error('Canvas input.json not found: ' + INPUT_PATH);
    }

    if (!fs.existsSync(OUTPUT_PATH)) {
        writeJson(OUTPUT_PATH, []);
    }

    if (!fs.existsSync(DELTAS_PATH)) {
        writeJson(DELTAS_PATH, []);
    }
};

const applyCanvasRuntime = runtime => {
    CANVAS_PATH = runtime.canvasPath;
    INPUT_PATH = runtime.inputPath;
    OUTPUT_PATH = runtime.outputPath;
    DELTAS_PATH = runtime.deltasPath;
    return runtime;
};

const createCanvasRuntime = canvasPath => {
    const resolvedCanvasPath = resolveConfigPath(canvasPath);

    return {
        canvasPath: resolvedCanvasPath,
        inputPath: path.join(resolvedCanvasPath, 'input.json'),
        outputPath: path.join(resolvedCanvasPath, 'output.json'),
        deltasPath: path.join(resolvedCanvasPath, 'deltas.json'),
        started: false,

        start() {
            applyCanvasRuntime(this);
            this.started = true;
            ensureActiveCanvasFiles();
            ensureCanvasesGitRepo();
            normalizeOutputJobs();
            activeOutputKeys.clear();
            startCanvasHermesHost(this.canvasPath);
            watchGraph();
            feedHermesOutput();
            return this;
        },

        stop() {
            if (activeCanvasRuntime !== this) {
                return this;
            }

            clearTimeout(watchTimer);
            watchTimer = null;
            watchers.forEach(watcher => watcher.close());
            watchers = [];
            activeOutputKeys.clear();
            stopCanvasHermesHost();
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

const outputText = () =>
    fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : '';

const readOutputJobs = () => {
    const text = outputText().trim();

    if (!text) {
        return [];
    }

    const value = JSON.parse(text);

    if (Array.isArray(value)) {
        return value.filter(isObject);
    }

    return isObject(value) && Object.keys(value).length ? [value] : [];
};

const readOutputJob = () => {
    const jobs = readOutputJobs();
    return [...jobs].reverse().find(job => job.status === 'pending' || job.status === 'running') || jobs[jobs.length - 1] || null;
};

const outputJobKey = job => {
    if (!job) {
        return null;
    }


    if (job.scope === 'canvas') {
        return 'canvas';
    }

    if (typeof job.componentKey === 'string' && job.componentKey.trim()) {
        return job.componentKey.trim();
    }

    if (typeof job.componentPath === 'string' && job.componentPath.trim()) {
        return resolveCanvasReference(job.componentPath);
    }

    if (job.target && typeof job.target === 'object' && typeof job.target.componentPath === 'string' && job.target.componentPath.trim()) {
        return resolveCanvasReference(job.target.componentPath);
    }

    if (typeof job.file === 'string' && job.file.trim()) {
        return resolveFromRoot(job.file);
    }

    return 'canvas';
};

const outputJobSummary = job => ({
    id: job && job.id ? job.id : null,
    status: job && job.status ? job.status : null,
    lane: job ? outputJobKey(job) : null,
    scope: job && job.scope ? job.scope : null,
    componentPath: job && job.componentPath ? job.componentPath : null,
    file: job && job.file ? job.file : null,
    prompt: job ? shortText(callbackPromptText(job)) : ''
});

const writeOutputJobs = async jobs =>
    withOutputLock(async () => {
        writeJson(OUTPUT_PATH, Array.isArray(jobs) ? jobs : []);
    });

const appendOutputJob = async job =>
    withOutputLock(async () => {
        const jobs = readOutputJobs();
        jobs.push(job);
        writeJson(OUTPUT_PATH, jobs);
        logServer('queue', 'job enqueued', {
            canvas: CANVAS_PATH,
            depth: jobs.filter(item => item && ['pending', 'running'].includes(item.status)).length,
            job: outputJobSummary(job)
        });
        return job;
    });

const updateOutputJob = async (jobId, patch) =>
    withOutputLock(async () => {
        const jobs = readOutputJobs();
        let updated = false;
        const nextJobs = jobs.map(job => {
            if (job.id !== jobId) {
                return job;
            }

            updated = true;
            return { ...job, ...patch };
        });

        if (updated) {
            writeJson(OUTPUT_PATH, nextJobs);
        }

        return updated;
    });

const normalizeOutputJobs = () => {
    const jobs = readOutputJobs();
    const normalized = jobs.map(job => (
        job && job.status === 'running'
            ? {
                ...job,
                status: 'pending',
                resumedAt: new Date().toISOString(),
                startedAt: null
            }
            : job
    ));

    if (normalized.length !== jobs.length || JSON.stringify(normalized) !== JSON.stringify(jobs)) {
        writeJson(OUTPUT_PATH, normalized);
        logServer('queue', 'normalized running jobs', {
            canvas: CANVAS_PATH,
            recovered: jobs.filter(job => job && job.status === 'running').length
        });
    } else if (!fs.existsSync(OUTPUT_PATH)) {
        writeJson(OUTPUT_PATH, []);
    }
};

const buildCanvasHermesArgs = () => {
    const liveArgs = [];

    for (let index = 0; index < AGENT_ARGS.length; index += 1) {
        const arg = AGENT_ARGS[index];

        if (arg === '--oneshot' || arg === '--query' || arg === '-q' || arg === '--resume' || arg === '-r' || arg === '--continue' || arg === '-c') {
            if (arg === '--query' || arg === '-q' || arg === '--resume' || arg === '-r' || arg === '--continue' || arg === '-c') {
                const next = AGENT_ARGS[index + 1];
                if (next && !String(next).startsWith('-')) {
                    index += 1;
                }
            }
            continue;
        }

        if (arg.startsWith('--query=') || arg.startsWith('--resume=') || arg.startsWith('--continue=')) {
            continue;
        }

        liveArgs.push(arg);
    }

    if (!liveArgs.some(arg => arg === '--source' || arg.startsWith('--source='))) {
        liveArgs.push('--source', 'tool');
    }

    if (ENABLED_HERMES_TOOLSETS.length && !liveArgs.some(arg => arg === '--toolsets' || arg === '-t' || arg.startsWith('--toolsets='))) {
        liveArgs.push('--toolsets', ENABLED_HERMES_TOOLSETS.join(','));
    }

    if (!liveArgs.some(arg => arg === '--quiet' || arg === '-Q')) {
        liveArgs.push('--quiet');
    }

    return liveArgs;
};

const buildCanvasHermesEnv = () => ({
    ...process.env,
    LIVE_EDIT_OUTPUT_PATH: OUTPUT_PATH,
    LIVE_EDIT_INPUT_PATH: INPUT_PATH,
    LIVE_EDIT_CANVAS_PATH: CANVAS_PATH
});

const canvasHermesBootstrapPrompt = () => [
    'Initialize enabled background watchers for this canvas.',
    'If any watcher needs a callback prompt or output path, configure it using the current canvas output file: ' + JSON.stringify(OUTPUT_PATH) + '.',
    'If a widget needs durable state, follow this process:',
    '1. Find or create the storage it needs.',
    '2. Organize that storage into a folder that belongs to the widget.',
    '3. Use that folder as the widget\'s source of truth.',
    '4. Read from that storage when handling callbacks.',
    '5. Make the smallest possible storage change needed for the request, preserving unrelated entries and existing state.',
    '6. Populate literal components from the stored state.',
    '7. Write loading and resolved states back through the canvas workflow, not by old-fashioned wiring.',
    'Treat component callbacks as separate lanes so one component cannot block another.',
    'If a watcher belongs to a visible widget, configure it with that widget\'s component folder as the lane key so it does not occupy the whole canvas lane.',
    'Remember that these are not typical apps; they are imaginary just-in-time widgets that only exist through the canvas and the agent.',
    'The callback prompt should make Hermes update the relevant visible component in the canvas, not write raw data back into the output file as the final result.',
    'When a callback benefits from it, use a loading state first and then a resolved state.',
    'Choose the callback prompt yourself.',
    'Reply with ok once the watcher is ready.'
].join(' ');

const stopCanvasHermesHost = () => {
    if (!activeCanvasHermes) {
        return false;
    }

    const host = activeCanvasHermes;
    activeCanvasHermes = null;
    host.stopped = true;

    if (host.bootstrapTimer) {
        clearTimeout(host.bootstrapTimer);
        host.bootstrapTimer = null;
    }

    try {
        host.proc.kill();
    } catch (error) {
        console.error('[hermes-host] failed to stop:', error.message);
    }

    return true;
};

const startCanvasHermesHost = canvasPath => {
    const resolvedCanvasPath = resolveConfigPath(canvasPath);

    if (activeCanvasHermes && activeCanvasHermes.canvasPath === resolvedCanvasPath && !activeCanvasHermes.exited) {
        return activeCanvasHermes;
    }

    stopCanvasHermesHost();

    const liveArgs = ['chat', ...buildCanvasHermesArgs()];
    console.log('[hermes-host] start args=' + JSON.stringify(liveArgs));

    const host = {
        canvasPath: resolvedCanvasPath,
        proc: pty.spawn(AGENT_COMMAND, liveArgs, {
            cwd: ROOT,
            env: buildCanvasHermesEnv(),
            cols: 120,
            rows: 40,
            name: 'xterm-color'
        }),
        startedAt: new Date().toISOString(),
        exited: false,
        stopped: false,
        exitCode: null,
        signal: null,
        outputTail: '',
        bootstrapSent: false
    };

    host.proc.onData(data => {
        host.outputTail = (host.outputTail + data).slice(-16384);
        writeProcessOutput('[hermes-host]', data);

        if (!host.bootstrapSent && (host.outputTail.includes('Ctrl+C cancel') || host.outputTail.includes('msg=interrupt'))) {
            try {
                const prompt = canvasHermesBootstrapPrompt();
                console.log('[hermes-host] bootstrap prompt=' + JSON.stringify(prompt));
                host.proc.write(prompt + '\r');
                host.bootstrapSent = true;
                host.bootstrapSentAt = new Date().toISOString();
                console.log('[hermes-host] bootstrap sent canvas=' + path.relative(CANVASES_ROOT, host.canvasPath));
            } catch (error) {
                console.error('[hermes-host] bootstrap write failed:', error.message);
            }
        }
    });

    host.bootstrapTimer = setTimeout(() => {
        if (host.exited || host.stopped || host.bootstrapSent) {
            return;
        }

        try {
            const prompt = canvasHermesBootstrapPrompt();
            console.log('[hermes-host] bootstrap prompt=' + JSON.stringify(prompt));
            host.proc.write(prompt + '\r');
            host.bootstrapSent = true;
            host.bootstrapSentAt = new Date().toISOString();
            console.log('[hermes-host] bootstrap sent canvas=' + path.relative(CANVASES_ROOT, host.canvasPath));
        } catch (error) {
            console.error('[hermes-host] bootstrap write failed:', error.message);
        }
    }, 750);

    host.proc.onExit(({ exitCode, signal }) => {
        host.exited = true;
        host.exitCode = exitCode;
        host.signal = signal;

        if (host.bootstrapTimer) {
            clearTimeout(host.bootstrapTimer);
            host.bootstrapTimer = null;
        }

        if (activeCanvasHermes === host) {
            activeCanvasHermes = null;
        }

        if (!host.stopped && CANVAS_PATH === host.canvasPath) {
            setTimeout(() => {
                if (!activeCanvasHermes && CANVAS_PATH === host.canvasPath) {
                    startCanvasHermesHost(host.canvasPath);
                }
            }, 1000);
        }

        console.log('[hermes-host] exited canvas=' + path.relative(CANVASES_ROOT, host.canvasPath) + ' code=' + exitCode + ' signal=' + (signal || 'none'));
    });

    activeCanvasHermes = host;
    console.log('[hermes-host] started canvas=' + path.relative(CANVASES_ROOT, host.canvasPath));
    return host;
};

const componentScripts = html =>
    Array.from(String(html || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi), match => match[1]);

const validateComponentFile = componentPath => {
    const component = readJson(componentPath);
    const html = String(component.html || '');

    if (/<[^>]*<script\b/i.test(html)) {
        throw new Error('Component HTML contains a <script> tag inside another opening tag');
    }

    componentScripts(html).forEach(script => {
        new Function(script);
    });
};

const validateCanvasConfig = () => {
    const input = readJson(INPUT_PATH);

    if (!Array.isArray(input.components)) {
        throw new Error('Canvas config must contain a components array');
    }

    input.components.forEach((componentPath, index) => {
        if (typeof componentPath !== 'string') {
            throw new Error('Canvas component path at index ' + index + ' must be a string');
        }
    });
};

const validateComponentFiles = componentPaths => {
    componentPaths.forEach(componentPath => {
        validateComponentFile(resolveCanvasReference(componentPath));
    });
};

const callbackPromptText = job => job.prompt || job.request || '';


const { ensureCanvasesGitRepo, commitCanvases } = createGitTimeline({
    canvasesRoot: CANVASES_ROOT,
    currentCanvasPath: () => CANVAS_PATH,
    logServer
});

const jobLaneSummary = job => ({
    id: job.id || null,
    scope: job.scope || null,
    componentKey: outputJobKey(job),
    status: job.status || null,
    prompt: callbackPromptText(job) || null,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null
});

const activeOutputJobs = () =>
    readOutputJobs().filter(job => ['pending', 'running'].includes(job.status) && callbackPromptText(job));

const dispatchableJobs = jobs => {
    const ready = [];
    const reservedKeys = new Set(activeOutputKeys);

    const pendingJobs = jobs
        .filter(job => job.status === 'pending' && callbackPromptText(job))
        .slice()
        .reverse();

    pendingJobs.forEach(job => {
        const key = outputJobKey(job);

        if (reservedKeys.has(key)) {
            return;
        }

        reservedKeys.add(key);
        ready.push(job);
    });

    return ready;
};

const scheduleOutputDispatch = () => {
    if (outputDispatchTimer) {
        return;
    }

    outputDispatchTimer = setTimeout(() => {
        outputDispatchTimer = null;
        dispatchOutputJobs().catch(error => {
            console.error('output dispatch error:', error);
        });
    }, 25);
};

const dispatchOutputJobs = async () => {
    if (outputDispatching) {
        return false;
    }

    outputDispatching = true;

    try {
        while (true) {
            const jobs = readOutputJobs();
            const ready = dispatchableJobs(jobs);

            if (!ready.length) {
                logServer('queue', 'dispatch idle', {
                    canvas: CANVAS_PATH,
                    pending: jobs.filter(job => job && job.status === 'pending' && callbackPromptText(job)).length,
                    running: jobs.filter(job => job && job.status === 'running' && callbackPromptText(job)).length,
                    activeLanes: Array.from(activeOutputKeys)
                });
                return false;
            }

            logServer('queue', 'dispatching jobs', {
                canvas: CANVAS_PATH,
                jobs: ready.map(outputJobSummary)
            });

            ready.forEach(job => {
                const laneKey = outputJobKey(job);
                activeOutputKeys.add(laneKey);
                logServer('queue', 'lane reserved', {
                    lane: laneKey,
                    job: outputJobSummary(job),
                    activeLanes: Array.from(activeOutputKeys)
                });
                processOutputJob(job).catch(error => {
                    console.error('agent job error:', error);
                    activeOutputKeys.delete(laneKey);
                    logServer('queue', 'lane released after uncaught job error', {
                        lane: laneKey,
                        error: error.message,
                        activeLanes: Array.from(activeOutputKeys)
                    });
                    scheduleOutputDispatch();
                });
            });

            if (ready.some(job => outputJobKey(job) === 'canvas')) {
                return true;
            }

            if (!readOutputJobs().some(job => job.status === 'pending' && callbackPromptText(job) && !activeOutputKeys.has(outputJobKey(job)))) {
                return true;
            }
        }
    } finally {
        outputDispatching = false;
    }
};

const agentJobPrompt = job => {
    const target = job.target || null;
    const promptText = callbackPromptText(job);

    if (target) {
        return [
            AGENT_PROMPT,
            '',
            'Dispatch lane:',
            outputJobKey(job),
            '',
            'Target component:',
            JSON.stringify({
                ...target,
                componentPath: target.componentPath ? componentScopePath(resolveCanvasReference(target.componentPath)) : target.componentPath || null
            }, null, 2),
            '',
            'Request:',
            promptText
        ].join('\n');
    }

    const componentPath = job.componentPath ? resolveCanvasReference(job.componentPath) : null;
    const componentFolder = componentPath ? componentScopePath(componentPath) : null;
    const componentJson = componentPath ? fs.readFileSync(componentPath, 'utf8') : null;
    const canvasJson = fs.readFileSync(INPUT_PATH, 'utf8');
    const canvasComponents = inputEntries().map(entry => componentScopePath(entry.componentPath));
    const representedFile = job.file ? resolveFromRoot(job.file) : null;
    const resources = Object.fromEntries(
        Object.entries(job.resources || {}).map(([name, resource]) => [
            name,
            {
                ...resource,
                path: resource.path ? resolveFromRoot(resource.path) : resource.path
            }
        ])
    );

    return [
        AGENT_PROMPT,
        '',
        'Dispatch lane:',
        outputJobKey(job),
        '',
        'Callback scope:',
        job.scope || 'component',
        '',
        'Allowed canvas config file for outer layout changes:',
        INPUT_PATH,
        '',
        'Allowed canvas component folders:',
        JSON.stringify(job.scope === 'canvas' ? canvasComponents : [componentFolder].filter(Boolean), null, 2),
        '',
        'Selected canvas components:',
        JSON.stringify(job.selectedComponents || [], null, 2),
        '',
        'Allowed component folder for this component callback:',
        componentFolder || '(none; this is a canvas callback)',
        '',
        'Allowed represented file for content/file changes:',
        representedFile || '(none)',
        '',
        'Allowed resource files:',
        JSON.stringify(resources, null, 2),
        '',
        'User request:',
        promptText,
        '',
        'Component metadata:',
        JSON.stringify({
            file: representedFile,
            resources,
            data: job.data || null
        }, null, 2),
        '',
        'Current canvas config JSON:',
        canvasJson,
        '',
        'Current component JSON:',
        componentJson || '(none)'
    ].join('\n');
};

const runAgentOneshot = (prompt, context = {}) =>
    new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        logServer('agent', 'starting oneshot', {
            command: AGENT_COMMAND,
            args: AGENT_ARGS,
            canvas: CANVAS_PATH,
            job: context.job || null
        });

        const proc = spawn(AGENT_COMMAND, [...AGENT_ARGS, prompt], {
            cwd: ROOT,
            env: {
                ...process.env,
                LIVE_EDIT_OUTPUT_PATH: OUTPUT_PATH,
                LIVE_EDIT_INPUT_PATH: INPUT_PATH,
                LIVE_EDIT_CANVAS_PATH: CANVAS_PATH
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        logServer('agent', 'spawned oneshot process', {
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

        proc.stdout.on('data', chunk => {
            stdout += chunk;
            writeProcessOutput(`[hermes-oneshot:${context.job || 'manual'}:stdout]`, chunk);
        });

        proc.stderr.on('data', chunk => {
            stderr += chunk;
            writeProcessOutput(`[hermes-oneshot:${context.job || 'manual'}:stderr]`, chunk, process.stderr);
        });

        proc.on('error', error => {
            clearTimeout(timeout);
            logServer('agent', 'oneshot process error', {
                error: error.message,
                job: context.job || null
            });
            reject(error);
        });

        proc.on('close', code => {
            clearTimeout(timeout);
            logServer('agent', 'oneshot process closed', {
                code,
                timedOut,
                stdoutBytes: Buffer.byteLength(stdout),
                stderrBytes: Buffer.byteLength(stderr),
                job: context.job || null
            });
            if (timedOut) {
                reject(new Error('Agent timed out after ' + AGENT_TIMEOUT_MS + 'ms'));
                return;
            }

            if (code !== 0) {
                reject(new Error('Agent exited with code ' + code + (stderr.trim() ? ': ' + stderr.trim() : '')));
                return;
            }

            resolve(stdout.trim());
        });
    });

const processOutputJob = async job => {
    const jobId = job.id || 'job-' + Date.now();
    const componentPath = job.componentPath ? resolveCanvasReference(job.componentPath) : null;
    const laneKey = outputJobKey(job);
    const isCanvasJob = job.scope === 'canvas' || laneKey === 'canvas';
    const startedAt = Date.now();

    logServer('queue', 'job claimed', {
        canvas: CANVAS_PATH,
        job: outputJobSummary({ ...job, id: jobId, componentPath }),
        lane: laneKey
    });

    await updateOutputJob(jobId, {
        ...job,
        id: jobId,
        componentKey: laneKey,
        status: 'running',
        startedAt: new Date().toISOString()
    });

    logServer('queue', 'job marked running', {
        job: outputJobSummary({ ...job, id: jobId, componentPath, status: 'running' })
    });

    try {
        const response = await runAgentOneshot(agentJobPrompt({ ...job, id: jobId, componentPath }), {
            job: outputJobSummary({ ...job, id: jobId, componentPath, status: 'running' })
        });

        logServer('agent', 'oneshot returned', {
            jobId,
            response: shortText(response)
        });

        validateCanvasConfig();

        if (isCanvasJob) {
            validateComponentFiles(inputEntries().map(entry => entry.componentPath));
        } else if (componentPath) {
            validateComponentFile(componentPath);
        } else {
            throw new Error('Component job is missing a componentPath');
        }
        await updateOutputJob(jobId, {
            status: 'done',
            completedAt: new Date().toISOString()
        });

        commitCanvases({ ...job, id: jobId });

        logServer('queue', 'job marked done', {
            jobId,
            lane: laneKey,
            durationMs: Date.now() - startedAt
        });
    } catch (error) {
        await updateOutputJob(jobId, {
            status: 'failed',
            failedAt: new Date().toISOString(),
            error: error.message
        });
        logServer('queue', 'job marked failed', {
            jobId,
            lane: laneKey,
            durationMs: Date.now() - startedAt,
            error: error.message
        });
    } finally {
        activeOutputKeys.delete(laneKey);
        logServer('queue', 'lane released', {
            lane: laneKey,
            jobId,
            activeLanes: Array.from(activeOutputKeys)
        });
        scheduleOutputDispatch();
    }
};

const feedHermesOutput = () => {
    logServer('queue', 'dispatch requested', {
        canvas: CANVAS_PATH,
        activeLanes: Array.from(activeOutputKeys)
    });
    scheduleOutputDispatch();
    return true;
};

const currentBusyState = key => {
    const activeJobs = activeOutputJobs();
    const componentKey = key ? String(key).trim() : '';
    const jobs = componentKey
        ? activeJobs.filter(job => job.scope === 'canvas' || outputJobKey(job) === componentKey)
        : activeJobs;
    const job = jobs[jobs.length - 1] || activeJobs[activeJobs.length - 1] || null;

    return {
        busy: Boolean(jobs.length),
        job: job ? jobLaneSummary(job) : null,
        jobs: jobs.map(jobLaneSummary)
    };
};

const canvasName = canvasPath =>
    path.relative(CANVASES_ROOT, canvasPath) || path.basename(canvasPath);

const availableCanvases = () =>
    fs.existsSync(CANVASES_ROOT)
        ? fs.readdirSync(CANVASES_ROOT, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => {
                const canvasPath = path.join(CANVASES_ROOT, entry.name);

                return {
                    name: entry.name,
                    path: canvasPath,
                    current: canvasPath === CANVAS_PATH,
                    valid: fs.existsSync(path.join(canvasPath, 'input.json'))
                };
            })
            .filter(canvas => canvas.valid)
        : [];


const readCanvasInputAt = canvasPath =>
    readJson(path.join(canvasPath, 'input.json'));

const switchCanvas = name => {
    if (!/^[^/][^/]*$/.test(name)) {
        const error = new Error('Invalid canvas name');
        error.statusCode = 400;
        throw error;
    }

    const canvasPath = path.join(CANVASES_ROOT, name);

    if (!fs.existsSync(path.join(canvasPath, 'input.json'))) {
        const error = new Error('Canvas not found: ' + name);
        error.statusCode = 404;
        throw error;
    }

    setCanvasPath(canvasPath);
};

const createCanvas = name => {
    const safeName = String(name || '').trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');

    if (!safeName) {
        const error = new Error('Canvas name is required');
        error.statusCode = 400;
        throw error;
    }

    if (fs.existsSync(path.join(CANVASES_ROOT, safeName))) {
        const error = new Error('Canvas already exists: ' + safeName);
        error.statusCode = 409;
        throw error;
    }

    ensureCanvasDefaults(safeName);
    return safeName;
};

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

const inputEntries = () => {
    const input = readJson(INPUT_PATH);

    if (!Array.isArray(input.components)) {
        throw new Error('input.json must contain { "components": [...] }');
    }

    return input.components.map((componentPath, index) => {
        if (typeof componentPath !== 'string') {
            throw new Error('input.json components[' + index + '] must be a string path');
        }

        return {
            index,
            componentPath: resolveCanvasReference(componentPath)
        };
    });
};

const leafComponents = () =>
    inputEntries().map(entry => ({
        ...entry,
        component: readJson(entry.componentPath)
    }));

const findLeafComponentByScope = scopePath => {
    if (!scopePath) {
        return null;
    }

    const absolute = resolveCanvasReference(scopePath);

    return leafComponents().find(entry =>
        entry.componentPath === scopePath
        || entry.componentPath === absolute
        || componentScopePath(entry.componentPath) === scopePath
    ) || null;
};

const resourceUrl = (componentPath, name) =>
    '/component/' + encodeURIComponent(componentScopePath(componentPath)) + '/resources/' + encodeURIComponent(name);

const componentFileUrl = componentPath =>
    '/component/' + encodeURIComponent(componentScopePath(componentPath)) + '/file';

const componentResources = component => {
    const resources = Object.fromEntries(
        Object.entries(component.resources || {}).map(([name, resource]) => [
            name,
            typeof resource === 'string' ? { path: resource } : resource
        ])
    );

    if (component.file && !resources.file) {
        resources.file = {
            path: component.file,
            mime: component.type
        };
    }

    return resources;
};

const renderedResources = (componentPath, resources) =>
    Object.fromEntries(
        Object.entries(resources).map(([name, resource]) => [
            name,
            {
                ...resource,
                url: resourceUrl(componentPath, name)
            }
        ])
    );

const renderedHtml = (componentPath, component, resources) =>
    (component.css ? '<style>' + String(component.css) + '</style>' : '')
    + String(component.html || '')
        .replaceAll('data-input-file', 'src="' + componentFileUrl(componentPath) + '"')
        .replace(/\{\{\s*componentPath\s*\}\}/g, componentScopePath(componentPath))
        .replace(/\{\{\s*componentFolder\s*\}\}/g, componentScopePath(componentPath))
        .replace(/\{\{\s*resources\.(.+?)\.url\s*\}\}/g, (match, name) =>
            resources[name.trim()] ? resourceUrl(componentPath, name.trim()) : match
        );

const renderedInput = () => ({
    ...readJson(INPUT_PATH),
    components: leafComponents().map(({ index, componentPath, component }) => {
        const resources = componentResources(component);

        return {
            ...component,
            index,
            componentPath,
            resources: renderedResources(componentPath, resources),
            file: component.file ? componentFileUrl(componentPath) : undefined,
            html: renderedHtml(componentPath, component, resources)
        };
    })
});

const watchedFiles = () =>
    Array.from(new Set([
        INPUT_PATH,
        DELTAS_PATH,
        ...leafComponents().flatMap(({ componentPath, component }) =>
            [
                componentPath,
                component.file,
                ...Object.values(componentResources(component)).map(resource => resource.path)
            ].filter(Boolean)
        )
    ]));

const broadcast = () => {
    clients.forEach(res => res.write('data: update\n\n'));
};

const scheduleWatchRefresh = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
        try {
            watchGraph();
            feedHermesOutput();
        } catch (error) {
            console.error('watch error:', error.message);
            broadcast();
            return;
        }

        broadcast();
    }, 50);
};

const watchGraph = () => {
    watchers.forEach(watcher => watcher.close());
    watchers = [];

    watchedFiles().forEach(file => {
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
    const request = String(body.request || body.prompt || '').trim();
    const isCanvasPrompt = !Object.hasOwn(body, 'target') && !Object.hasOwn(body, 'componentIndex');

    if (!request) {
        throw new Error('Prompt requires prompt text');
    }


    if (isCanvasPrompt) {
        logServer('callback', 'received canvas prompt', {
            canvas: CANVAS_PATH,
            request,
            selectedComponents: Array.isArray(body.selectedComponents) ? body.selectedComponents.length : 0
        });
        await appendOutputJob({
            id: 'output-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            scope: CANVAS_PATH,
            status: 'pending',
            createdAt: new Date().toISOString(),
            componentKey: 'canvas',
            selectedComponents: Array.isArray(body.selectedComponents) ? body.selectedComponents : [],
            prompt: request
        });
        return;
    }

    const target = body.target || null;
    const canonicalTarget = target
        ? (() => {
            const targetComponentPath = target.componentPath ? resolveCanvasReference(target.componentPath) : null;

            return targetComponentPath
                ? {
                    ...readJson(targetComponentPath),
                    componentPath: targetComponentPath
                }
                : target;
        })()
        : null;
    const index = Number(body.componentIndex);
    const leaf = canonicalTarget
        ? {
            component: canonicalTarget,
            componentPath: canonicalTarget.componentPath || null
        }
        : leafComponents()[index];

    if (!leaf) {
        throw new Error('Prompt requires a valid target or componentIndex and request');
    }

    logServer('callback', 'received component prompt', {
        canvas: CANVAS_PATH,
        request,
        componentPath: leaf.componentPath || null,
        file: leaf.component.file || null
    });
    await appendOutputJob({
        id: 'output-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        scope: leaf.componentPath || leaf.component.file || null,
        status: 'pending',
        createdAt: new Date().toISOString(),
        componentKey: leaf.componentPath || leaf.component.file || null,
        file: leaf.component.file || null,
        resources: componentResources(leaf.component),
        data: leaf.component.data || null,
        target: canonicalTarget,
        prompt: request
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
            req.on('close', () => clients.delete(res));
            return;
        }


        if (req.method === 'GET' && url.pathname === '/agents/probe') {
            send(res, 200, JSON.stringify(probeLocalAgents()), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'GET' && url.pathname === '/input') {
            send(res, 200, JSON.stringify(renderedInput()), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'GET' && url.pathname === '/status') {
            const componentPath = url.searchParams.get('componentPath') || '';
            send(res, 200, JSON.stringify(currentBusyState(componentPath)), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'GET' && url.pathname === '/canvases') {
            send(res, 200, JSON.stringify({
                current: canvasName(CANVAS_PATH),
                canvases: availableCanvases()
            }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/canvas') {
            const body = JSON.parse(await readBody(req));

            switchCanvas(String(body.name || ''));
            broadcast();
            send(res, 200, JSON.stringify({
                current: canvasName(CANVAS_PATH),
                canvases: availableCanvases()
            }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/canvases') {
            const body = JSON.parse(await readBody(req));
            const name = createCanvas(body.name);

            switchCanvas(name);
            commitCanvases({ scope: 'canvas', prompt: 'create canvas: ' + name });
            broadcast();
            send(res, 201, JSON.stringify({
                current: canvasName(CANVAS_PATH),
                canvases: availableCanvases()
            }), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/output') {
            await appendOutput(req);
            feedHermesOutput();
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
            const component = leafComponents()[Number(inputFile[1])]?.component;

            if (!component?.file) {
                send(res, 404, 'Input file not found');
                return;
            }

            streamFile(req, res, component.file, component.type);
            return;
        }

        const inputResource = url.pathname.match(/^\/input\/(\d+)\/resources\/(.+)$/);

        if (req.method === 'GET' && inputResource) {
            const component = leafComponents()[Number(inputResource[1])]?.component;
            const name = decodeURIComponent(inputResource[2]);
            const resource = component && componentResources(component)[name];

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
            const component = findLeafComponentByScope(componentPath)?.component;

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
            const component = findLeafComponentByScope(componentPath)?.component;
            const name = decodeURIComponent(componentResource[2]);
            const resource = component && componentResources(component)[name];

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
        console.error('request error:', error);
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

    return stopCanvasHermesHost();
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
    console.log('Deltas: ' + DELTAS_PATH);
});
