const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { copySkillsTreeToRoot } = require('./skills');

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

    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1] || fallback;
};

const timeoutMilliseconds = () => {
    const value = Number.parseInt(argValue('--agent-timeout-ms', ''), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
};
const permissionMode = () => argValue('--claude-permission-mode', 'bypassPermissions').trim() || 'bypassPermissions';
const extraArguments = () => argValue('--claude-args', '').split(' ').filter(Boolean);
const commandCandidates = () => [
    process.env.LIQUIDOS_CLAUDE_COMMAND,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    'claude'
].filter(candidate => typeof candidate === 'string' && candidate.trim());

const commandExists = candidate => {
    if (!candidate) {
        return false;
    }

    if (path.isAbsolute(candidate)) {
        return fs.existsSync(candidate);
    }

    return String(process.env.PATH || '')
        .split(path.delimiter)
        .some(directory => directory && fs.existsSync(path.join(directory, candidate)));
};

const command = commandCandidates().find(commandExists) || 'claude';

const commandInstalled = () => {
    return commandExists(command);
};

const configureClaudeCodeAgent = nextHost => {
    host = {
        output: typeof nextHost?.output === 'function' ? nextHost.output : host.output,
        status: typeof nextHost?.status === 'function' ? nextHost.status : host.status
    };
};

const claudeRuntimePaths = ({ runtimePath } = {}) => [
    runtimePath ? path.join(runtimePath, '.claude') : null
].filter(Boolean);

const materializeClaudeRuntime = ({ runtimePath, skillsPath } = {}) => {
    const runtimePaths = claudeRuntimePaths({ runtimePath });

    runtimePaths.forEach(runtimePath => {
        copySkillsTreeToRoot(skillsPath, runtimePath);
    });

    return runtimePaths;
};

const runtimeAccessArguments = ({ systemPromptPath, canvasPath } = {}) => {
    const accessDirectories = [
        systemPromptPath ? path.dirname(systemPromptPath) : null,
        canvasPath || null
    ].filter(Boolean);

    return accessDirectories.length ? ['--add-dir', ...accessDirectories] : [];
};

const ClaudeCodeAgent = () => {
    const currentDebug = {
        kind: 'claude-code',
        label: 'Claude Code',
        command,
        status: 'waiting',
        provider: 'anthropic-claude-code',
        model: null,
        source: 'claude-code'
    };

    const setStatus = next => {
        Object.assign(currentDebug, next, { at: new Date().toISOString() });
        host.status({ ...currentDebug });
    };

    return {
        kind: 'claude-code',
        label: 'Claude Code',
        command,
        configureHost: configureClaudeCodeAgent,
        isInstalled: () => commandInstalled(),
        initialize: () => setStatus({ status: 'waiting' }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        runtimePaths: claudeRuntimePaths,
        materializeRuntime: materializeClaudeRuntime,
        run: (prompt, { workingDirectory, systemPromptPath, canvasPath } = {}) => new Promise((resolve, reject) => {
            if (!workingDirectory) {
                reject(new Error('ClaudeCodeAgent.run requires a workingDirectory'));
                return;
            }

            let output = '';
            let errorOutput = '';
            let timedOut = false;
            const processHandle = spawn(command, [
                '-p',
                prompt,
                '--verbose',
                '--output-format',
                'stream-json',
                '--include-partial-messages',
                ...(systemPromptPath ? ['--system-prompt-file', systemPromptPath] : []),
                ...runtimeAccessArguments({ systemPromptPath, canvasPath }),
                '--allowedTools',
                'WebSearch',
                'WebFetch',
                '--permission-mode',
                permissionMode(),
                ...extraArguments()
            ], {
                cwd: workingDirectory,
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            setStatus({
                status: 'running',
                pid: processHandle.pid || null,
                startedAt: new Date().toISOString(),
                permissionMode: permissionMode(),
                cwd: workingDirectory,
                systemPromptPath: systemPromptPath || null,
                canvasPath: canvasPath || null
            });

            const timeout = timeoutMilliseconds();
            const timeoutHandle = timeout !== null
                ? setTimeout(() => {
                    timedOut = true;
                    processHandle.kill('SIGTERM');
                }, timeout)
                : null;

            processHandle.stderr.on('data', chunk => {
                errorOutput += chunk;
                host.output('claude-code-process', chunk);
            });

            processHandle.stdout.on('data', chunk => {
                output += chunk;
                host.output('claude-code-process', chunk);
            });

            processHandle.on('close', (exitCode, signal) => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                }

                if (timedOut) {
                    setStatus({ status: 'timed out', signal });
                    reject(new Error('Claude Code timed out after ' + timeoutMilliseconds() + 'ms'));
                    return;
                }

                if (exitCode !== 0) {
                    setStatus({ status: 'failed', exitCode, signal });
                    reject(new Error(String(errorOutput || output || '').trim() || ('Claude Code exited with code ' + exitCode)));
                    return;
                }

                setStatus({ status: 'waiting', exitCode, signal });
                resolve(output.trim());
            });

            processHandle.on('error', error => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                }
                setStatus({ status: 'error', error: error.message });
                reject(error);
            });
        })
    };
};

module.exports = {
    ClaudeCodeAgent,
    configureClaudeCodeAgent
};
