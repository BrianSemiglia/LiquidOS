const path = require('path');

const createHermesHost = ({
    root,
    canvasesRoot,
    agentCommand,
    agentArgs,
    enabledToolsets,
    hermesBootstrap,
    getCanvasPath,
    getInputPath,
    getOutputPath,
    logServer,
    logHermesError,
    shortText,
    setCurrentAgentDebug,
    writeProcessOutput,
    pty
}) => {
    let activeCanvasHermes = null;
    let hermesJobQueue = Promise.resolve();

    const stripAnsi = value =>
        String(value || '')
            .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
            .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
            .replace(/\r/g, '');

    const buildCanvasHermesArgs = () => {
        const liveArgs = [...hermesBootstrap.selectedHermesLaunchArgs()];

        for (let index = 0; index < agentArgs.length; index += 1) {
            const arg = agentArgs[index];

            if (arg === '--oneshot' || arg === '--query' || arg === '-q' || arg === '--resume' || arg === '-r' || arg === '--continue' || arg === '-c') {
                if (arg === '--query' || arg === '-q' || arg === '--resume' || arg === '-r' || arg === '--continue' || arg === '-c') {
                    const next = agentArgs[index + 1];
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

        if (Array.isArray(enabledToolsets) && enabledToolsets.length && !liveArgs.some(arg => arg === '--toolsets' || arg === '-t' || arg.startsWith('--toolsets='))) {
            liveArgs.push('--toolsets', enabledToolsets.join(','));
        }

        if (!liveArgs.some(arg => arg === '--quiet' || arg === '-Q')) {
            liveArgs.push('--quiet');
        }

        return liveArgs;
    };

    const buildCanvasHermesEnv = () => ({
        ...process.env,
        ...hermesBootstrap.selectedHermesLaunchEnv(),
        LIVE_EDIT_OUTPUT_PATH: getOutputPath(),
        LIVE_EDIT_INPUT_PATH: getInputPath(),
        LIVE_EDIT_CANVAS_PATH: getCanvasPath()
    });

    const activeHermesJobMarker = jobId => `[[LIQUIDOS_JOB_DONE:${jobId}]]`;

    const stripHermesJobMarker = (text, marker) =>
        String(text || '')
            .split(/\r?\n/)
            .filter(line => line.trim() !== marker)
            .join('\n')
            .trim();

    const waitForCanvasHermesHost = async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (!activeCanvasHermes) {
                startCanvasHermesHost(getCanvasPath());
            }

            if (activeCanvasHermes && !activeCanvasHermes.exited && activeCanvasHermes.bootstrapSent) {
                return activeCanvasHermes;
            }

            await new Promise(resolve => setTimeout(resolve, 50));
        }

        throw new Error('Hermes host is not ready');
    };

    const submitHermesJobToHost = (prompt, context = {}) => {
        const jobId = context.job && context.job.id ? context.job.id : 'job-' + Date.now();
        const marker = activeHermesJobMarker(jobId);

        hermesJobQueue = hermesJobQueue
            .catch(() => {})
            .then(async () => {
                const host = await waitForCanvasHermesHost();

                return await new Promise((resolve, reject) => {
                    if (host.activeJob) {
                        reject(new Error('Hermes host is already busy'));
                        return;
                    }

                    host.activeJob = {
                        jobId,
                        marker,
                        stdout: '',
                        resolve,
                        reject
                    };

                    try {
                        logServer('agent', 'sending prompt to Hermes host', {
                            jobId,
                            canvas: path.relative(canvasesRoot, host.canvasPath),
                            prompt: typeof shortText === 'function' ? shortText(prompt) : String(prompt || '').trim().slice(0, 240),
                            promptChars: String(prompt || '').length,
                            job: context.job || null
                        });
                        host.proc.write([
                            prompt,
                            '',
                            'When the task is complete, output a single line exactly:',
                            marker,
                            ''
                        ].join('\n') + '\r');
                    } catch (error) {
                        host.activeJob = null;
                        reject(error);
                    }
                });
            });

        return hermesJobQueue;
    };

    const stopCanvasHermesHost = () => {
        if (!activeCanvasHermes) {
            return false;
        }

        const host = activeCanvasHermes;
        activeCanvasHermes = null;
        host.stopped = true;

        try {
            host.proc.kill();
        } catch (error) {
            logHermesError('hermes-host', error, { message: 'failed to stop' });
        }

        setCurrentAgentDebug({
            kind: 'hermes-host',
            label: 'Hermes host',
            command: agentCommand,
            status: 'stopped',
            canvas: path.relative(canvasesRoot, host.canvasPath),
            startedAt: host.startedAt,
            exitedAt: new Date().toISOString(),
            exitCode: host.exitCode,
            signal: host.signal,
            provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
            model: hermesBootstrap.currentHermesBootstrapState().model || null
        });

        return true;
    };

    const startCanvasHermesHost = canvasPath => {
        const resolvedCanvasPath = path.resolve(canvasPath || getCanvasPath());

        if (activeCanvasHermes && !activeCanvasHermes.exited) {
            return activeCanvasHermes;
        }

        if (!hermesBootstrap.currentHermesBootstrapState().configured) {
            logServer('hermes-host', 'waiting for Hermes model selection before start');
            setCurrentAgentDebug({
                kind: 'idle',
                label: 'Idle',
                command: agentCommand,
                status: 'waiting for Hermes model selection',
                provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
                model: hermesBootstrap.currentHermesBootstrapState().model || null
            });
            return null;
        }

        const liveArgs = ['chat', ...buildCanvasHermesArgs()];
        logServer('hermes-host', 'cwd=' + canvasesRoot + ' start args=' + JSON.stringify(liveArgs));

        const host = {
            canvasPath: resolvedCanvasPath,
            proc: pty.spawn(agentCommand, liveArgs, {
                cwd: canvasesRoot,
                env: buildCanvasHermesEnv(),
                cols: 180,
                rows: 60,
                name: 'xterm-color'
            }),
            startedAt: new Date().toISOString(),
            exited: false,
            stopped: false,
            exitCode: null,
            signal: null,
            outputTail: '',
            bootstrapSent: false,
            activeJob: null
        };

        setCurrentAgentDebug({
            kind: 'hermes-host',
            label: 'Hermes host',
            command: agentCommand,
            status: 'running',
            canvas: path.relative(canvasesRoot, host.canvasPath),
            startedAt: host.startedAt,
            pid: host.proc.pid || null,
            provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
            model: hermesBootstrap.currentHermesBootstrapState().model || null
        });

        host.proc.onData(data => {
            host.outputTail = (host.outputTail + data).slice(-16384);
            writeProcessOutput('[hermes-host]', data);

            if (host.activeJob) {
                host.activeJob.stdout += data;
                if (host.outputTail.includes(host.activeJob.marker)) {
                    const finishedJob = host.activeJob;
                    host.activeJob = null;
                    finishedJob.resolve(stripHermesJobMarker(finishedJob.stdout, finishedJob.marker));
                }
            }
        });
        host.bootstrapSent = true;
        host.bootstrapSentAt = new Date().toISOString();
        logServer('hermes-host', 'bootstrap ready canvas=' + path.relative(canvasesRoot, host.canvasPath));

        host.proc.onExit(({ exitCode, signal }) => {
            host.exited = true;
            host.exitCode = exitCode;
            host.signal = signal;

            if (activeCanvasHermes === host) {
                activeCanvasHermes = null;
            }

            if (host.activeJob) {
                const activeJob = host.activeJob;
                host.activeJob = null;
                activeJob.reject(new Error('Hermes host exited before completing job'));
            }

            setCurrentAgentDebug({
                kind: 'idle',
                label: 'Idle',
                command: agentCommand,
                status: 'waiting',
                provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
                model: hermesBootstrap.currentHermesBootstrapState().model || null
            });

            if (!host.stopped && getCanvasPath() === host.canvasPath) {
                setTimeout(() => {
                    if (!activeCanvasHermes && getCanvasPath() === host.canvasPath) {
                        startCanvasHermesHost(host.canvasPath);
                    }
                }, 1000);
            }

            logServer('hermes-host', 'exited canvas=' + path.relative(canvasesRoot, host.canvasPath) + ' code=' + exitCode + ' signal=' + (signal || 'none'));
        });

        activeCanvasHermes = host;
        logServer('hermes-host', 'started canvas=' + path.relative(canvasesRoot, host.canvasPath));
        return host;
    };

    const run = (prompt, context = {}) =>
        submitHermesJobToHost(prompt, context);

    const snapshot = () => ({
        active: Boolean(activeCanvasHermes && !activeCanvasHermes.exited),
        canvas: activeCanvasHermes && !activeCanvasHermes.exited ? path.relative(canvasesRoot, activeCanvasHermes.canvasPath) : '',
        startedAt: activeCanvasHermes && !activeCanvasHermes.exited ? activeCanvasHermes.startedAt : null,
        pid: activeCanvasHermes && !activeCanvasHermes.exited ? activeCanvasHermes.proc.pid || null : null,
        transcript: activeCanvasHermes && !activeCanvasHermes.exited
            ? stripAnsi(activeCanvasHermes.outputTail || '').replace(/\r/g, '\n')
            : ''
    });

    const isRunning = () => Boolean(activeCanvasHermes && !activeCanvasHermes.exited);

    return {
        startCanvasHermesHost,
        stopCanvasHermesHost,
        submitHermesJobToHost,
        run,
        snapshot,
        isRunning
    };
};

module.exports = {
    createHermesHost
};
