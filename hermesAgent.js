const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { createHermesBootstrap } = require('./hermesBootstrap');

let host = {
    output: () => {},
    status: () => {}
};

const root = __dirname;

const argValue = (name, fallback) => {
    const prefix = name + '=';
    const inline = process.argv.find(arg => arg.startsWith(prefix));

    if (inline) {
        return inline.slice(prefix.length);
    }

    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1] || fallback;
};

const resolveHermesCommand = () =>
    argValue('--agent', argValue('--agent-command', argValue('--hermes-command', 'hermes')));

const command = resolveHermesCommand();
const timeoutMilliseconds = () => Number.parseInt(argValue('--agent-timeout-ms', '300000'), 10);
const rawAgentArguments = () => argValue('--agent-args', argValue('--hermes-args', '')).split(' ').filter(Boolean);

const hermesBootstrap = createHermesBootstrap({
    root,
    agentCommand: command
});

const commandInstalled = () => {
    if (path.isAbsolute(command)) {
        return fs.existsSync(command);
    }

    return String(process.env.PATH || '')
        .split(path.delimiter)
        .some(directory => directory && fs.existsSync(path.join(directory, command)));
};

const selectedLaunchEnvironment = () => ({
    ...process.env,
    ...hermesBootstrap.selectedHermesLaunchEnv()
});

const buildChatArguments = () => {
    const argumentsList = [...hermesBootstrap.selectedHermesLaunchArgs()];

    for (let index = 0; index < rawAgentArguments().length; index += 1) {
        const argument = rawAgentArguments()[index];

        if (argument === '--oneshot' || argument === '--query' || argument === '-q' || argument === '--resume' || argument === '-r' || argument === '--continue' || argument === '-c') {
            if (argument !== '--oneshot' && rawAgentArguments()[index + 1] && !String(rawAgentArguments()[index + 1]).startsWith('-')) {
                index += 1;
            }
            continue;
        }

        if (argument.startsWith('--query=') || argument.startsWith('--resume=') || argument.startsWith('--continue=')) {
            continue;
        }

        argumentsList.push(argument);
    }

    if (!argumentsList.some(argument => argument === '--source' || argument.startsWith('--source='))) {
        argumentsList.push('--source', 'tool');
    }

    if (!argumentsList.some(argument => argument === '--quiet' || argument === '-Q')) {
        argumentsList.push('--quiet');
    }

    return ['chat', ...argumentsList];
};

const stripAnsi = value =>
    String(value || '')
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
        .replace(/\r/g, '');

const markerFor = () => '[[LIQUIDOS_JOB_DONE:' + Date.now() + '-' + Math.random().toString(36).slice(2) + ']]';

const withoutMarker = (text, marker) =>
    String(text || '')
        .split(/\r?\n/)
        .filter(line => line.trim() !== marker)
        .join('\n')
        .trim();

const configureHermesAgent = nextHost => {
    host = {
        output: typeof nextHost?.output === 'function' ? nextHost.output : host.output,
        status: typeof nextHost?.status === 'function' ? nextHost.status : host.status
    };
};

const HermesAgent = () => {
    let processHandle = null;
    let outputTail = '';
    let activeJob = null;
    let activeWorkingDirectory = null;
    let jobQueue = Promise.resolve();
    const currentDebug = {
        kind: 'hermes',
        label: 'Hermes',
        command,
        status: 'waiting',
        provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
        model: hermesBootstrap.currentHermesBootstrapState().model || null,
        source: path.isAbsolute(command) ? 'absolute' : 'global'
    };

    const setStatus = next => {
        Object.assign(currentDebug, next, { at: new Date().toISOString() });
        host.status({ ...currentDebug });
    };

    const stop = () => {
        if (processHandle) {
            processHandle.kill('SIGTERM');
            processHandle = null;
        }
        activeWorkingDirectory = null;
    };

    const start = workingDirectory => {
        if (!workingDirectory) {
            throw new Error('HermesAgent.run requires a workingDirectory');
        }

        if (processHandle && activeWorkingDirectory === workingDirectory) {
            return processHandle;
        }

        if (processHandle) {
            stop();
        }

        activeWorkingDirectory = workingDirectory;

        setStatus({
            command,
            status: 'spawning',
            cwd: workingDirectory,
            args: buildChatArguments(),
            provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
            model: hermesBootstrap.currentHermesBootstrapState().model || null
        });

        processHandle = pty.spawn(command, buildChatArguments(), {
            name: 'xterm-color',
            cols: 160,
            rows: 50,
            cwd: workingDirectory,
            env: selectedLaunchEnvironment()
        });

        setStatus({
            command,
            status: 'running',
            pid: processHandle.pid || null,
            startedAt: new Date().toISOString(),
            provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
            model: hermesBootstrap.currentHermesBootstrapState().model || null
        });

        processHandle.onData(chunk => {
            outputTail = (outputTail + chunk).slice(-16384);
            host.output('hermes', chunk);

            if (activeJob) {
                activeJob.output += chunk;
                if (outputTail.includes(activeJob.marker)) {
                    clearTimeout(activeJob.timeout);
                    activeJob.resolve(withoutMarker(activeJob.output, activeJob.marker));
                    activeJob = null;
                    setStatus({ status: 'waiting' });
                }
            }
        });

        processHandle.onExit(({ exitCode, signal }) => {
            const runningJob = activeJob;
            processHandle = null;
            activeWorkingDirectory = null;
            activeJob = null;
            setStatus({ status: 'exited', exitCode, signal });

            if (runningJob) {
                clearTimeout(runningJob.timeout);
                runningJob.reject(new Error('Hermes exited before completing the job'));
            }
        });

        if (typeof processHandle.on === 'function') {
            processHandle.on('error', error => {
            const runningJob = activeJob;
            processHandle = null;
            activeWorkingDirectory = null;
            activeJob = null;
            setStatus({ status: 'error', error: error.message });

            if (runningJob) {
                clearTimeout(runningJob.timeout);
                runningJob.reject(error);
            }
            });
        }

        return processHandle;
    };

    const run = (prompt, { workingDirectory } = {}) => {
        jobQueue = jobQueue
            .catch(() => {})
            .then(() => new Promise((resolve, reject) => {
                if (activeJob) {
                    reject(new Error('Hermes is already running a job'));
                    return;
                }

                const marker = markerFor();
                activeJob = {
                    marker,
                    output: '',
                    resolve,
                    reject,
                    timeout: setTimeout(() => {
                        const timedOutJob = activeJob;
                        activeJob = null;
                        setStatus({ status: 'timed out' });
                        if (timedOutJob) {
                            timedOutJob.reject(new Error('Hermes timed out after ' + timeoutMilliseconds() + 'ms'));
                        }
                    }, timeoutMilliseconds())
                };

                try {
                    start(workingDirectory).write([
                        prompt,
                        '',
                        'When the task is complete, output a single line exactly:',
                        marker,
                        ''
                    ].join('\n') + '\r');
                } catch (error) {
                    clearTimeout(activeJob.timeout);
                    activeJob = null;
                    setStatus({ status: 'error', error: error.message });
                    reject(error);
                }
            }));

        return jobQueue;
    };

    return {
        kind: 'hermes',
        label: 'Hermes',
        command,
        isInstalled: commandInstalled,
        initialize: ({ workingDirectory } = {}) => {
            start(workingDirectory || activeWorkingDirectory);
        },
        dispose: stop,
        currentDebug: () => ({
            ...currentDebug,
            transcript: stripAnsi(outputTail || '').replace(/\r/g, '\n'),
            provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
            model: hermesBootstrap.currentHermesBootstrapState().model || null
        }),
        selectBackend: id => {
            const result = hermesBootstrap.selectHermesBackend(id);
            setStatus({
                status: result.ok ? 'waiting' : 'error',
                provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
                model: hermesBootstrap.currentHermesBootstrapState().model || null,
                error: result.ok ? null : result.error
            });
            return result;
        },
        run
    };
};

module.exports = {
    HermesAgent,
    configureHermesAgent
};
