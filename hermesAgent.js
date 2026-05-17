const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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

const filteredAgentArguments = () => {
    const argumentsList = [];

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

    return argumentsList;
};

const hasToolsetArgument = args =>
    args.some(argument => argument === '-t' || argument === '--toolsets' || argument.startsWith('-t=') || argument.startsWith('--toolsets='));

const defaultToolsetArguments = args =>
    hasToolsetArgument(args) ? [] : ['-t', 'files,shell,web'];

const buildOneShotArguments = prompt => {
    const launchArguments = [
        ...hermesBootstrap.selectedHermesLaunchArgs(),
        ...filteredAgentArguments()
    ];

    return [
        ...launchArguments,
        ...defaultToolsetArguments(launchArguments),
        'chat',
        '--query',
        String(prompt || '')
    ];
};

const displayArguments = args =>
    args.map((argument, index) => index > 0 && (args[index - 1] === '-z' || args[index - 1] === '--query' || args[index - 1] === '-q') ? '<prompt>' : argument);

const debugLine = (label, fields = {}) => [
    '[LiquidOS Hermes]',
    label,
    ...Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => key + '=' + JSON.stringify(value))
].join(' ') + '\n';

const stripAnsi = value =>
    String(value || '')
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
        .replace(/\r/g, '');

const stripHermesQueryPrefix = value =>
    String(value || '').replace(/(^|\n)Query:\s*/g, '$1');

const configureHermesAgent = nextHost => {
    host = {
        output: typeof nextHost?.output === 'function' ? nextHost.output : host.output,
        status: typeof nextHost?.status === 'function' ? nextHost.status : host.status
    };
};

const HermesAgent = () => {
    let processHandle = null;
    let outputTail = '';
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

    const emitDebug = (label, fields = {}) => {
        const text = debugLine(label, fields);
        outputTail = (outputTail + text).slice(-16384);
        host.output('hermes', text);
    };

    const runOneShot = (prompt, workingDirectory, resolve, reject) => {
        if (!workingDirectory) {
            reject(new Error('HermesAgent.run requires a workingDirectory'));
            return;
        }

        const args = buildOneShotArguments(prompt);
        let stdout = '';
        let stderr = '';
        activeWorkingDirectory = workingDirectory;

        emitDebug('spawn', {
            command,
            cwd: workingDirectory,
            args: displayArguments(args)
        });

        setStatus({
            command,
            status: 'spawning',
            cwd: workingDirectory,
            args: displayArguments(args),
            provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
            model: hermesBootstrap.currentHermesBootstrapState().model || null
        });

        processHandle = spawn(command, args, {
            cwd: workingDirectory,
            env: selectedLaunchEnvironment(),
            stdio: ['ignore', 'pipe', 'pipe']
        });


        emitDebug('running', { pid: processHandle.pid || null });

        setStatus({
            command,
            status: 'running',
            pid: processHandle.pid || null,
            startedAt: new Date().toISOString(),
            provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
            model: hermesBootstrap.currentHermesBootstrapState().model || null
        });

        processHandle.stdout.on('data', chunk => {
            const text = stripHermesQueryPrefix(chunk.toString());
            stdout += text;
            outputTail = (outputTail + text).slice(-16384);
            host.output('hermes', text);
        });

        processHandle.stderr.on('data', chunk => {
            const text = stripHermesQueryPrefix(chunk.toString());
            stderr += text;
            outputTail = (outputTail + text).slice(-16384);
            host.output('hermes', text, process.stderr);
        });

        processHandle.on('error', error => {
            emitDebug('error', { error: error.message });
            processHandle = null;
            activeWorkingDirectory = null;
            setStatus({ status: 'error', error: error.message });
            reject(error);
        });

        processHandle.on('close', (exitCode, signal) => {
            emitDebug('close', { exitCode, signal });
            processHandle = null;
            activeWorkingDirectory = null;

            setStatus({
                status: exitCode === 0 ? 'waiting' : 'error',
                exitCode,
                signal,
                provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
                model: hermesBootstrap.currentHermesBootstrapState().model || null
            });

            if (exitCode === 0) {
                resolve(stripAnsi(stdout).trim());
                return;
            }

            reject(new Error(stripAnsi(stderr || stdout).trim() || 'Hermes exited with code ' + exitCode));
        });
    };

    const run = (prompt, { workingDirectory } = {}) => {
        jobQueue = jobQueue
            .catch(() => {})
            .then(() => new Promise((resolve, reject) => {
                if (processHandle) {
                    reject(new Error('Hermes is already running a job'));
                    return;
                }

                runOneShot(prompt, workingDirectory, resolve, reject);
            }));

        return jobQueue;
    };

    return {
        kind: 'hermes',
        label: 'Hermes',
        command,
        isInstalled: commandInstalled,
        initialize: ({ workingDirectory } = {}) => {
            activeWorkingDirectory = workingDirectory || activeWorkingDirectory;
            setStatus({
                command,
                status: 'waiting',
                cwd: activeWorkingDirectory || null,
                args: displayArguments([...hermesBootstrap.selectedHermesLaunchArgs(), ...filteredAgentArguments(), 'chat', '--query', '<prompt>']),
                provider: hermesBootstrap.currentHermesBootstrapState().provider || null,
                model: hermesBootstrap.currentHermesBootstrapState().model || null
            });
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
