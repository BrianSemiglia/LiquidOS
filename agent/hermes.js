const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let host = {
    output: () => {},
    status: () => {}
};

const argValue = (name, fallback) => {
    const prefix = name + '=';
    const inline = process.argv.find(argument => argument.startsWith(prefix));

    if (inline) {
        return inline.slice(prefix.length);
    }

    return process.argv.indexOf(name) === -1 ? fallback : process.argv[process.argv.indexOf(name) + 1] || fallback;
};

const timeoutMilliseconds = () => Number.parseInt(argValue('--agent-timeout-ms', '300000'), 10);
const command = argValue('--agent', argValue('--agent-command', argValue('--hermes-command', 'hermes')));
const rawAgentArguments = () => argValue('--agent-args', argValue('--hermes-args', '')).split(' ').filter(Boolean);

const commandInstalled = () => path.isAbsolute(command)
    ? fs.existsSync(command)
    : String(process.env.PATH || '')
        .split(path.delimiter)
        .some(directory => directory && fs.existsSync(path.join(directory, command)));

const filteredAgentArguments = () => {
    const skippedValueFlags = new Set([
        '--oneshot',
        '-z',
        '--query',
        '-q',
        '--resume',
        '-r',
        '--continue',
        '-c'
    ]);
    const skippedBareFlags = new Set([
        'chat',
        '--verbose',
        '-v',
        '--quiet',
        '-Q'
    ]);
    const skippedPrefixes = [
        '--oneshot=',
        '--query=',
        '--resume=',
        '--continue='
    ];
    const result = [];

    for (let index = 0; index < rawAgentArguments().length; index += 1) {
        if (skippedBareFlags.has(rawAgentArguments()[index])) {
            continue;
        }

        if (skippedValueFlags.has(rawAgentArguments()[index])) {
            if (rawAgentArguments()[index + 1] && !String(rawAgentArguments()[index + 1]).startsWith('-')) {
                index += 1;
            }
            continue;
        }

        if (skippedPrefixes.some(prefix => rawAgentArguments()[index].startsWith(prefix))) {
            continue;
        }

        result.push(rawAgentArguments()[index]);
    }

    return result;
};

const hasToolsetArgument = args => args.some(argument =>
    argument === '-t' ||
    argument === '--toolsets' ||
    argument.startsWith('-t=') ||
    argument.startsWith('--toolsets=')
);

const defaultToolsetArguments = args => hasToolsetArgument(args) ? [] : ['-t', 'files,shell,web'];

const buildOneShotArguments = prompt => [
    ...filteredAgentArguments(),
    ...defaultToolsetArguments(filteredAgentArguments()),
    'chat',
    '-q',
    String(prompt || '')
];

const displayArguments = args => args.map((argument, index) => ['-q', '--query'].includes(args[index - 1]) ? '<prompt>' : argument);

const debugLine = (label, fields = {}) => [
    '[LiquidOS Hermes]',
    label,
    ...Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => key + '=' + JSON.stringify(value))
].join(' ') + '\n';

const stripAnsi = value => String(value || '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\r/g, '');

const configureHermesAgent = nextHost => {
    host = {
        output: typeof nextHost?.output === 'function' ? nextHost.output : host.output,
        status: typeof nextHost?.status === 'function' ? nextHost.status : host.status
    };
};

const argumentValueFrom = (args, name) => {
    const prefix = name + '=';
    const inline = args.find(argument => argument.startsWith(prefix));

    if (inline) {
        return inline.slice(prefix.length);
    }

    return args.indexOf(name) === -1 ? null : args[args.indexOf(name) + 1] || null;
};

const HermesAgent = () => {
    const currentDebug = {
        kind: 'hermes',
        label: 'Hermes',
        command,
        status: 'waiting',
        provider: argumentValueFrom(filteredAgentArguments(), '--provider'),
        model: argumentValueFrom(filteredAgentArguments(), '--model'),
        source: path.isAbsolute(command) ? 'absolute' : 'global'
    };

    const setStatus = next => {
        Object.assign(currentDebug, next, { at: new Date().toISOString() });
        host.status({ ...currentDebug });
    };

    const emitDebug = (label, fields = {}) => host.output('hermes', debugLine(label, fields));

    return {
        kind: 'hermes',
        label: 'Hermes',
        command,
        isInstalled: () => commandInstalled(),
        initialize: ({ workingDirectory } = {}) => setStatus({
            status: 'waiting',
            cwd: workingDirectory || null,
            args: displayArguments(buildOneShotArguments('<prompt>'))
        }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        run: (prompt, { workingDirectory, systemPromptPath } = {}) => new Promise((resolve, reject) => {
            if (!workingDirectory) {
                reject(new Error('HermesAgent.run requires a workingDirectory'));
                return;
            }

            const args = buildOneShotArguments(prompt);
            let output = '';
            let errorOutput = '';
            let timedOut = false;
            const processHandle = spawn(command, args, {
                cwd: workingDirectory,
                env: {
                    ...process.env,
                    TERMINAL_CWD: workingDirectory
                },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            emitDebug('spawn', {
                command,
                cwd: workingDirectory,
                terminalCwd: workingDirectory,
                systemPromptPath: systemPromptPath || null,
                args: displayArguments(args)
            });

            setStatus({
                status: 'running',
                pid: processHandle.pid || null,
                startedAt: new Date().toISOString(),
                cwd: workingDirectory,
                terminalCwd: workingDirectory,
                systemPromptPath: systemPromptPath || null,
                args: displayArguments(args)
            });

            const timeout = setTimeout(() => {
                timedOut = true;
                processHandle.kill('SIGTERM');
            }, timeoutMilliseconds());

            processHandle.stdout.on('data', chunk => {
                output += chunk;
                host.output('hermes', chunk);
            });

            processHandle.stderr.on('data', chunk => {
                errorOutput += chunk;
                host.output('hermes', chunk, process.stderr);
            });

            processHandle.on('close', (exitCode, signal) => {
                clearTimeout(timeout);
                emitDebug('close', { exitCode, signal });

                if (timedOut) {
                    setStatus({ status: 'timed out', signal });
                    reject(new Error('Hermes timed out after ' + timeoutMilliseconds() + 'ms'));
                    return;
                }

                if (exitCode !== 0) {
                    setStatus({ status: 'failed', exitCode, signal });
                    reject(new Error(stripAnsi(errorOutput || output).trim() || 'Hermes exited with code ' + exitCode));
                    return;
                }

                setStatus({ status: 'waiting', exitCode, signal });
                resolve(stripAnsi(output).trim());
            });

            processHandle.on('error', error => {
                clearTimeout(timeout);
                setStatus({ status: 'error', error: error.message });
                reject(error);
            });
        })
    };
};

module.exports = {
    HermesAgent,
    configureHermesAgent
};
