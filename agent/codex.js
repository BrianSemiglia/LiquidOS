const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { copySkillsTreeToRoot } = require('./skills');
const { promptWithAgentSystemPrompt } = require('./system-prompt');

let host = {
    output: () => {},
    status: () => {}
};

const argValue = (name, fallback) => {
    const prefix = name + '=';
    const inline = process.argv.find(arg => arg.startsWith(prefix));

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
const command = 'codex';

const commandInstalled = () => {
    if (path.isAbsolute(command)) {
        return fs.existsSync(command);
    }

    return String(process.env.PATH || '')
        .split(path.delimiter)
        .some(directory => directory && fs.existsSync(path.join(directory, command)));
};

const configureCodexAgent = nextHost => {
    host = {
        output: typeof nextHost?.output === 'function' ? nextHost.output : host.output,
        status: typeof nextHost?.status === 'function' ? nextHost.status : host.status
    };
};

const codexRuntimePaths = ({ runtimePath } = {}) => [
    runtimePath ? path.join(runtimePath, '.codex') : null
].filter(Boolean);

const materializeCodexRuntime = ({ runtimePath, skillsPath } = {}) => {
    const runtimePaths = codexRuntimePaths({ runtimePath });

    runtimePaths.forEach(runtimePath => {
        copySkillsTreeToRoot(skillsPath, runtimePath);
    });

    return runtimePaths;
};

const CodexAgent = () => {
    const currentDebug = {
        kind: 'codex',
        label: 'Codex',
        command,
        status: 'waiting',
        provider: 'openai-codex',
        model: 'gpt-5.4-mini',
        source: 'codex'
    };

    const setStatus = next => {
        Object.assign(currentDebug, next, { at: new Date().toISOString() });
        host.status({ ...currentDebug });
    };

    return {
        kind: 'codex',
        label: 'Codex',
        command,
        configureHost: configureCodexAgent,
        isInstalled: () => commandInstalled(),
        initialize: () => setStatus({ status: 'waiting' }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: prompt => prompt,
        runtimePaths: codexRuntimePaths,
        materializeRuntime: materializeCodexRuntime,
        run: (prompt, { workingDirectory, canvasPath, systemPromptPath } = {}) => new Promise((resolve, reject) => {
            if (!workingDirectory) {
                reject(new Error('CodexAgent.run requires a workingDirectory'));
                return;
            }
            let output = '';
            let timedOut = false;
            // codex exec has no system-prompt flag; the cross-agent convention
            // here is to inject the AGENTS.md content programmatically rather
            // than rely on the CLI's AGENTS.md auto-discovery. promptWithAgent-
            // SystemPrompt prepends the file's contents to the user prompt.
            const composedPrompt = promptWithAgentSystemPrompt({ prompt, systemPromptPath });
            const processHandle = spawn(command, [
                'exec',
                '--sandbox',
                'workspace-write',
                ...(canvasPath ? ['--add-dir', canvasPath] : []),
                '--skip-git-repo-check',
                '--cd',
                workingDirectory,
                composedPrompt
            ], {
                cwd: workingDirectory,
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            setStatus({
                status: 'running',
                pid: processHandle.pid || null,
                startedAt: new Date().toISOString(),
                cwd: workingDirectory,
                canvasPath: canvasPath || null
            });

            const timeout = timeoutMilliseconds();
            const timeoutHandle = timeout !== null
                ? setTimeout(() => {
                    timedOut = true;
                    processHandle.kill('SIGTERM');
                }, timeout)
                : null;

            processHandle.stdout.on('data', chunk => {
                output += chunk;
                host.output('codex-exec-process', chunk);
            });

            processHandle.stderr.on('data', chunk => {
                output += chunk;
                host.output('codex-exec-process', chunk);
            });

            processHandle.on('close', (exitCode, signal) => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                }

                if (timedOut) {
                    setStatus({ status: 'timed out', signal });
                    reject(new Error('Codex timed out after ' + timeoutMilliseconds() + 'ms'));
                    return;
                }

                if (exitCode !== 0) {
                    setStatus({ status: 'failed', exitCode, signal });
                    reject(new Error('Codex exited with code ' + exitCode));
                    return;
                }

                setStatus({ status: 'waiting', exitCode, signal });
                resolve(output);
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
    CodexAgent,
    configureCodexAgent
};
