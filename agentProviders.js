const createAgentProviders = ({
    root,
    canvasesRoot,
    hermesCommand,
    hermesBootstrap,
    hermesHost,
    commandExists,
    logServer,
    shortText,
    setCurrentAgentDebug,
    writeProcessOutput,
    pty,
    agentTimeoutMs
}) => {
    const activeAgentDebugLabel = kind => (kind === 'codex' ? 'Codex' : 'Hermes');

    const codexInstalled = () => commandExists('codex');

    const describeActiveHermes = () => {
        const state = hermesBootstrap.currentHermesBootstrapState();

        return {
            provider: state.provider || null,
            model: state.model || null
        };
    };

    const setIdleDebug = ({ kind, command, provider, model, source, status = 'waiting' }) => {
        setCurrentAgentDebug({
            kind: 'idle',
            label: activeAgentDebugLabel(kind),
            command,
            status,
            provider,
            model,
            source
        });
    };

    const runCodexPromptProcess = (prompt, context = {}) =>
        new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            const outputLabel = 'codex-exec-process';
            const liveWorkdir = context.canvasPath || root;
            const liveArgs = [
                'exec',
                '--sandbox',
                'workspace-write',
                '--skip-git-repo-check',
                '--cd',
                liveWorkdir,
                '--add-dir',
                canvasesRoot,
                prompt
            ];

            logServer('agent', 'starting codex exec process', {
                command: 'codex',
                args: liveArgs,
                canvas: context.canvasPath || null,
                job: context.job || null
            });
            logServer('agent', 'sending prompt to Codex exec process', {
                canvas: context.canvasPath || null,
                prompt: shortText(prompt),
                promptChars: String(prompt || '').length,
                job: context.job || null
            });

            const proc = pty.spawn(
                'codex',
                liveArgs,
                {
                    name: 'xterm-color',
                    cols: 160,
                    rows: 50,
                    cwd: liveWorkdir,
                    env: {
                        ...process.env,
                        LIVE_EDIT_OUTPUT_PATH: context.outputPath || '',
                        LIVE_EDIT_INPUT_PATH: context.inputPath || '',
                        LIVE_EDIT_CANVAS_PATH: context.canvasPath || ''
                    }
                }
            );

            setCurrentAgentDebug({
                kind: 'codex-exec',
                label: 'Codex exec process',
                command: 'codex',
                status: 'running',
                job: context.job || null,
                pid: proc.pid || null,
                startedAt: new Date().toISOString(),
                provider: 'openai-codex',
                model: 'gpt-5.4-mini',
                source: 'codex'
            });

            const timeout = setTimeout(() => {
                timedOut = true;
                logServer('agent', 'timeout; sending SIGTERM', {
                    pid: proc.pid,
                    timeoutMs: agentTimeoutMs,
                    job: context.job || null
                });
                proc.kill('SIGTERM');
            }, agentTimeoutMs);

            proc.onData(chunk => {
                stdout += chunk;
                writeProcessOutput(outputLabel, chunk);
            });

            proc.onExit(({ exitCode, signal }) => {
                clearTimeout(timeout);
                logServer('agent', 'codex exec process closed', {
                    code: exitCode,
                    signal,
                    timedOut,
                    stdoutBytes: Buffer.byteLength(stdout),
                    stderrBytes: Buffer.byteLength(stderr),
                    job: context.job || null
                });
                if (timedOut) {
                    setIdleDebug({
                        kind: 'codex',
                        command: 'codex',
                        provider: 'openai-codex',
                        model: 'gpt-5.4-mini',
                        source: 'codex',
                        status: 'timed out'
                    });
                    reject(new Error('Agent timed out after ' + agentTimeoutMs + 'ms'));
                    return;
                }

                if (exitCode !== 0) {
                    setIdleDebug({
                        kind: 'codex',
                        command: 'codex',
                        provider: 'openai-codex',
                        model: 'gpt-5.4-mini',
                        source: 'codex',
                        status: 'failed'
                    });
                    reject(new Error('Agent exited with code ' + exitCode + (stderr.trim() ? ': ' + stderr.trim() : '')));
                    return;
                }

                setIdleDebug({
                    kind: 'codex',
                    command: 'codex',
                    provider: 'openai-codex',
                    model: 'gpt-5.4-mini',
                    source: 'codex'
                });

                resolve(stdout.trim());
            });

            proc.on('error', error => {
                clearTimeout(timeout);
                logServer('agent', 'codex exec process error', {
                    error: error.message,
                    job: context.job || null
                });
                setCurrentAgentDebug({
                    kind: 'idle',
                    label: 'Idle',
                    command: 'codex',
                    status: 'error',
                    error: error.message,
                    provider: 'openai-codex',
                    model: 'gpt-5.4-mini',
                    source: 'codex'
                });
                reject(error);
            });
        });

    const providers = {
        hermes: {
            kind: 'hermes',
            label: 'Hermes',
            command: hermesCommand,
            isInstalled: () => commandExists(hermesCommand),
            probe: () => {
                const state = describeActiveHermes();

                return {
                    installed: commandExists(hermesCommand),
                    usable: commandExists(hermesCommand),
                    command: hermesCommand,
                    configured: hermesBootstrap.currentHermesBootstrapState().configured,
                    provider: state.provider,
                    model: state.model
                };
            },
            describe: () => ({
                id: 'hermes',
                label: 'Hermes',
                installed: commandExists(hermesCommand)
            }),
            startCanvas: canvasPath => {
                if (hermesBootstrap.currentHermesBootstrapState().configured) {
                    hermesHost.startCanvasHermesHost(canvasPath);
                }
            },
            stopCanvas: () => hermesHost.stopCanvasHermesHost(),
            run: (prompt, context = {}) => hermesHost.run(prompt, context),
            currentDebug: () => ({
                command: hermesCommand,
                provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
                model: hermesBootstrap.currentHermesBootstrapState().model || null
            })
        },
        codex: {
            kind: 'codex',
            label: 'Codex',
            command: 'codex',
            isInstalled: codexInstalled,
            probe: () => ({
                installed: codexInstalled(),
                usable: codexInstalled(),
                command: 'codex',
                configured: true,
                provider: 'openai-codex',
                model: 'gpt-5.4-mini'
            }),
            describe: () => ({
                id: 'codex',
                label: 'Codex',
                installed: codexInstalled()
            }),
            startCanvas: () => {},
            stopCanvas: () => {},
            run: (prompt, context = {}) => runCodexPromptProcess(prompt, context),
            currentDebug: () => ({
                command: 'codex',
                provider: 'openai-codex',
                model: 'gpt-5.4-mini'
            })
        }
    };

    let activeKind = 'codex';

    const active = () => providers[activeKind] || providers.hermes;

    const availableKinds = () => [
        providers.hermes.describe(),
        providers.codex.describe()
    ];

    const probe = () => ({
        hermes: providers.hermes.probe(),
        agents: [
            {
                id: 'codex',
                label: 'Codex',
                command: 'codex',
                installed: codexInstalled(),
                usable: codexInstalled(),
                provider: 'openai-codex',
                model: 'gpt-5.4-mini'
            },
            {
                id: 'claude-code',
                label: 'Claude Code',
                command: 'claude',
                installed: commandExists('claude'),
                usable: commandExists('claude'),
                provider: 'anthropic',
                model: 'anthropic/claude-sonnet-4.6'
            }
        ],
        agentKind: activeKind,
        agentChoices: availableKinds()
    });

    const setActiveKind = (kind, canvasPath = null) => {
        const normalized = String(kind || '').trim().toLowerCase();

        if (!providers[normalized]) {
            return {
                ok: false,
                statusCode: 400,
                error: 'Unknown agent kind.'
            };
        }

        if (!providers[normalized].isInstalled()) {
            return {
                ok: false,
                statusCode: 409,
                error: providers[normalized].label + ' is not installed on this machine.'
            };
        }

        if (activeKind === normalized) {
            return {
                ok: true,
                agent: {
                    kind: activeKind,
                    label: providers[activeKind].label
                }
            };
        }

        providers[activeKind].stopCanvas();
        activeKind = normalized;
        providers[activeKind].startCanvas(canvasPath);

        setCurrentAgentDebug({
            kind: 'idle',
            label: providers[activeKind].label,
            command: providers[activeKind].command,
            status: 'waiting',
            provider: providers[activeKind].currentDebug().provider || null,
            model: providers[activeKind].currentDebug().model || null,
            source: activeKind === 'codex' ? 'codex' : 'bundled'
        });

        return {
            ok: true,
            agent: {
                kind: activeKind,
                label: providers[activeKind].label
            }
        };
    };

    const startActiveCanvas = canvasPath => active().startCanvas(canvasPath);
    const stopActiveCanvas = () => active().stopCanvas();
    const runActive = (prompt, context = {}) => active().run(prompt, context);

    return {
        availableKinds,
        probe,
        setActiveKind,
        activeKind: () => activeKind,
        activeProvider: active,
        startActiveCanvas,
        stopActiveCanvas,
        runActive
    };
};

module.exports = {
    createAgentProviders
};
