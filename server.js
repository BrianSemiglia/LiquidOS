const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const pty = require('node-pty');

const ROOT = __dirname;
const SERVER_BUILD = 'hermes-output-server-2026-05-07-canvas-host-session';

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

const relativeCanvasPath = value =>
    path.relative(CANVAS_PATH, value).split(path.sep).join('/');

const componentScopePath = componentPath =>
    relativeCanvasPath(path.dirname(componentPath));

const CANVASES_ROOT = path.join(ROOT, 'canvases');
const CANVAS_TEMPLATE_ROOT = path.join(ROOT, 'templates', 'canvas');
const DEFAULT_CANVAS_PATH = fs.existsSync(path.join(CANVASES_ROOT, 'random-pdfs', 'input.json'))
    ? path.join(CANVASES_ROOT, 'random-pdfs')
    : ROOT;
let CANVAS_PATH = resolveConfigPath(argValue('--canvas', DEFAULT_CANVAS_PATH));
let INPUT_PATH = path.join(CANVAS_PATH, 'input.json');
let OUTPUT_PATH = path.join(CANVAS_PATH, 'output.json');
let DELTAS_PATH = path.join(CANVAS_PATH, 'deltas.json');
const PORT = Number.parseInt(argValue('--port', '3000'), 10);
const AGENT_COMMAND = argValue('--agent', argValue('--hermes-command', 'hermes'));
const AGENT_ARGS = argValue('--agent-args', argValue('--hermes-args', '--oneshot')).split(' ').filter(Boolean);
const AGENT_TIMEOUT_MS = Number.parseInt(argValue('--agent-timeout-ms', '300000'), 10);
const AGENT_PROMPT = argValue('--agent-prompt', argValue('--hermes-prompt', [
    'You are LiquidOS, a just-in-time operating system.',
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
    'Perform two separate valid JSON filesystem writes. First, update whichever component JSON files are needed to show a visible loading state and lock relevant controls or inputs, save those files to disk, and parse each changed JSON file before doing side effects, external reads, or longer reasoning.',
    'For component-scoped callbacks, the target component is relevant unless the request clearly identifies another allowed component. For canvas-scoped callbacks, inspect the current canvas config and allowed component files to choose relevant components; use selected components as hints only when they are supplied.',
    'Second, after the work completes, write the resolved or failed state to disk and unlock controls that should be usable again. Do not defer the loading-state write until the final answer.',
    'Do not edit output.json, deltas.json, server.js, or files outside the allowed paths.',
    'When you obtain useful output, write it into the canvas by updating the allowed canvas config or component JSON. Do not treat opening a browser, reading a page, or reporting in chat as completion unless the canvas is also updated.',
    'When you want to communicate results or messages to the user, spawn a new component JSON file in the instance components/ directory, then add its path to input.json so it appears on the canvas.',
    'For research/search tasks, add or update a component that shows the results, sources, links, and next actions in the canvas.',
    'After editing a component, parse the component JSON and syntax-check embedded script blocks.',
    'After editing the canvas config, parse the canvas config JSON.',
    'The user ONLY sees the canvas - they do not see chat messages. ALL communication must be rendered as components.',
    'Reply with a one-line summary.'
].join(' ')));

const clients = new Set();
let watchers = [];
let watchTimer;
let processingDeltas = false;
let activeCanvasHermes = null;
let outputDispatchTimer = null;
let outputDispatching = false;
const activeOutputKeys = new Set();
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

const ensureCanvasFiles = () => {
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

const setCanvasPath = canvasPath => {
    const nextCanvasPath = resolveConfigPath(canvasPath);

    CANVAS_PATH = nextCanvasPath;
    INPUT_PATH = path.join(CANVAS_PATH, 'input.json');
    OUTPUT_PATH = path.join(CANVAS_PATH, 'output.json');
    DELTAS_PATH = path.join(CANVAS_PATH, 'deltas.json');
    ensureCanvasFiles();
    startCanvasHermesHost(CANVAS_PATH);
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
        return resolveFromRoot(job.componentPath);
    }

    if (job.target && typeof job.target === 'object' && typeof job.target.componentPath === 'string' && job.target.componentPath.trim()) {
        return resolveFromRoot(job.target.componentPath);
    }

    if (typeof job.file === 'string' && job.file.trim()) {
        return resolveFromRoot(job.file);
    }

    return 'canvas';
};

const writeOutputJobs = async jobs =>
    withOutputLock(async () => {
        writeJson(OUTPUT_PATH, Array.isArray(jobs) ? jobs : []);
    });

const appendOutputJob = async job =>
    withOutputLock(async () => {
        const jobs = readOutputJobs();
        jobs.push(job);
        writeJson(OUTPUT_PATH, jobs);
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
        validateComponentFile(resolveFromRoot(componentPath));
    });
};

const callbackPromptText = job => job.prompt || job.request || '';

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
                return false;
            }

            ready.forEach(job => {
                const laneKey = outputJobKey(job);
                activeOutputKeys.add(laneKey);
                processOutputJob(job).catch(error => {
                    console.error('agent job error:', error);
                    activeOutputKeys.delete(laneKey);
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
                componentPath: target.componentPath ? componentScopePath(resolveFromRoot(target.componentPath)) : target.componentPath || null
            }, null, 2),
            '',
            'Request:',
            promptText
        ].join('\n');
    }

    const componentPath = job.componentPath ? resolveFromRoot(job.componentPath) : null;
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

const runAgentOneshot = prompt =>
    new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;

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

        const timeout = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGTERM');
        }, AGENT_TIMEOUT_MS);

        proc.stdout.on('data', chunk => {
            stdout += chunk;
            process.stdout.write(chunk);
        });

        proc.stderr.on('data', chunk => {
            stderr += chunk;
            process.stderr.write(chunk);
        });

        proc.on('error', error => {
            clearTimeout(timeout);
            reject(error);
        });

        proc.on('close', code => {
            clearTimeout(timeout);
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
    const componentPath = job.componentPath ? resolveFromRoot(job.componentPath) : null;
    const laneKey = outputJobKey(job);
    const isCanvasJob = job.scope === 'canvas' || laneKey === 'canvas';

    await updateOutputJob(jobId, {
        ...job,
        id: jobId,
        componentKey: laneKey,
        status: 'running',
        startedAt: new Date().toISOString()
    });

    try {
        const response = await runAgentOneshot(agentJobPrompt({ ...job, id: jobId, componentPath }));

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
            completedAt: new Date().toISOString(),
            response
        });
    } catch (error) {
        await updateOutputJob(jobId, {
            status: 'failed',
            failedAt: new Date().toISOString(),
            error: error.message
        });
    } finally {
        activeOutputKeys.delete(laneKey);
        scheduleOutputDispatch();
    }
};

const feedHermesOutput = () => {
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
    processDeltas();
    watchGraph();
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

    const canvasPath = path.join(CANVASES_ROOT, safeName);

    if (fs.existsSync(canvasPath)) {
        const error = new Error('Canvas already exists: ' + safeName);
        error.statusCode = 409;
        throw error;
    }

    fs.mkdirSync(canvasPath, { recursive: true });

    if (fs.existsSync(CANVAS_TEMPLATE_ROOT)) {
        const copyTemplate = (source, target) => {
            fs.mkdirSync(target, { recursive: true });

            for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
                if (entry.name === '.gitkeep') {
                    continue;
                }

                const sourcePath = path.join(source, entry.name);
                const targetPath = path.join(target, entry.name);

                if (entry.isDirectory()) {
                    copyTemplate(sourcePath, targetPath);
                } else if (entry.isFile()) {
                    fs.copyFileSync(sourcePath, targetPath);
                }
            }
        };

        copyTemplate(CANVAS_TEMPLATE_ROOT, canvasPath);
    }

    fs.mkdirSync(path.join(canvasPath, 'components'), { recursive: true });
    writeJson(path.join(canvasPath, 'input.json'), {
        components: [],
        css: 'body{background:#0b1120}'
    });
    writeJson(path.join(canvasPath, 'output.json'), []);
    writeJson(path.join(canvasPath, 'deltas.json'), []);
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

const processDeltas = () => {
    if (processingDeltas || !fs.existsSync(DELTAS_PATH)) {
        return false;
    }

    processingDeltas = true;

    try {
        const deltas = readJson(DELTAS_PATH);
        let changed = false;

        if (!Array.isArray(deltas)) {
            throw new Error('deltas.json must be an array');
        }

        deltas.forEach(delta => {
            if (delta.format !== 'json-patch') {
                return;
            }

            try {
                if (delta.status === 'pending') {
                    delta.patches = ensurePatchBefores(delta.patches || []);
                    applyPatchSet(delta.patches);
                    delta.status = 'applied';
                    delta.appliedAt = new Date().toISOString();
                    changed = true;
                    return;
                }

                if (delta.status === 'rollback-pending') {
                    const rollbackPatches = (delta.patches || []).map(patch => ({
                        ...patch,
                        ops: inverseOps(patch.ops || [])
                    }));
                    applyPatchSet(rollbackPatches);
                    delta.status = 'rolled-back';
                    delta.rolledBackAt = new Date().toISOString();
                    changed = true;
                    return;
                }

                if (delta.status === 'reapply-pending') {
                    applyPatchSet(delta.patches || []);
                    delta.status = 'applied';
                    delta.reappliedAt = new Date().toISOString();
                    changed = true;
                }
            } catch (error) {
                delta.status = 'failed';
                delta.error = error.message;
                delta.failedAt = new Date().toISOString();
                changed = true;
            }
        });

        if (changed) {
            writeJson(DELTAS_PATH, deltas);
        }

        return changed;
    } finally {
        processingDeltas = false;
    }
};

const requestDeltaStep = direction => {
    const deltas = fs.existsSync(DELTAS_PATH) ? readJson(DELTAS_PATH) : [];

    if (!Array.isArray(deltas)) {
        throw new Error('deltas.json must be an array');
    }

    const toStatus = direction === 'undo' ? 'rollback-pending' : 'reapply-pending';
    const candidates = deltas.filter(delta =>
        delta.format === 'json-patch'
        && delta.status === (direction === 'undo' ? 'applied' : 'rolled-back')
    );
    const target = direction === 'undo'
        ? candidates[candidates.length - 1]
        : candidates.sort((a, b) =>
            String(b.rolledBackAt || '').localeCompare(String(a.rolledBackAt || ''))
        )[0];

    if (!target) {
        const error = new Error(direction === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
        error.statusCode = 409;
        throw error;
    }

    target.status = toStatus;
    target.requestedAt = new Date().toISOString();
    writeJson(DELTAS_PATH, deltas);

    return processDeltas();
};

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
            componentPath: resolveFromRoot(componentPath)
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

    const absolute = resolveFromRoot(scopePath);

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
            const deltasChanged = processDeltas();
            watchGraph();

            if (deltasChanged) {
                scheduleWatchRefresh();
            }

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
    const isCanvasPrompt = body.scope === 'canvas';

    if (!request) {
        throw new Error('Prompt requires prompt text');
    }

    if (isCanvasPrompt) {
        console.log('[callback] received canvas prompt', JSON.stringify({
            request,
            selectedComponents: Array.isArray(body.selectedComponents) ? body.selectedComponents.length : 0
        }));
        await appendOutputJob({
            id: 'output-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            scope: 'canvas',
            status: 'pending',
            createdAt: new Date().toISOString(),
            canvasPath: CANVAS_PATH,
            inputPath: INPUT_PATH,
            componentKey: 'canvas',
            selectedComponents: Array.isArray(body.selectedComponents) ? body.selectedComponents : [],
            request,
            prompt: request
        });
        return;
    }

    const target = body.target || null;
    const canonicalTarget = target
        ? (() => {
            const targetComponentPath = target.componentPath ? resolveFromRoot(target.componentPath) : null;

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

    console.log('[callback] received component prompt', JSON.stringify({
        request,
        componentPath: leaf.componentPath || null,
        file: leaf.component.file || null
    }));
    await appendOutputJob({
        id: 'output-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        scope: 'component',
        status: 'pending',
        createdAt: new Date().toISOString(),
        componentPath: leaf.componentPath || null,
        componentKey: leaf.componentPath || leaf.component.file || null,
        file: leaf.component.file || null,
        resources: componentResources(leaf.component),
        data: leaf.component.data || null,
        target: canonicalTarget,
        request,
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

        if (req.method === 'POST' && (url.pathname === '/deltas/undo' || url.pathname === '/deltas/redo')) {
            const direction = url.pathname.endsWith('/undo') ? 'undo' : 'redo';

            requestDeltaStep(direction);
            watchGraph();
            broadcast();
            send(res, 200, JSON.stringify({ ok: true, direction }), 'application/json; charset=utf-8');
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

ensureCanvasFiles();
normalizeOutputJobs();
startCanvasHermesHost(CANVAS_PATH);
processDeltas();
watchGraph();
feedHermesOutput();

const shutdownCanvasHermes = () => {
    stopCanvasHermesHost();
};

process.on('exit', shutdownCanvasHermes);
process.on('SIGINT', () => {
    shutdownCanvasHermes();
    process.exit(130);
});
process.on('SIGTERM', () => {
    shutdownCanvasHermes();
    process.exit(143);
});

server.listen(PORT, () => {
    console.log('Build: ' + SERVER_BUILD);
    console.log('Server at http://localhost:' + PORT);
    console.log('Canvas: ' + CANVAS_PATH);
    console.log('Input: ' + INPUT_PATH);
    console.log('Output: ' + OUTPUT_PATH);
    console.log('Deltas: ' + DELTAS_PATH);
});
