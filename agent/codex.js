const fs = require('fs');
const path = require('path');
const pty = require('node-pty');

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

const timeoutMilliseconds = () => Number.parseInt(argValue('--agent-timeout-ms', '300000'), 10);
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
        isInstalled: commandInstalled,
        initialize: () => setStatus({ status: 'waiting' }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: prompt => prompt,
        run: (prompt, { workingDirectory, canvasPath } = {}) => new Promise((resolve, reject) => {
            if (!workingDirectory) {
                reject(new Error('CodexAgent.run requires a workingDirectory'));
                return;
            }
            let output = '';
            let timedOut = false;
            const processHandle = pty.spawn(command, [
                'exec',
                '--sandbox',
                'workspace-write',
                ...(canvasPath ? ['--add-dir', canvasPath] : []),
                '--skip-git-repo-check',
                '--cd',
                workingDirectory,
                prompt
            ], {
                name: 'xterm-color',
                cols: 160,
                rows: 50,
                cwd: workingDirectory,
                env: process.env
            });

            setStatus({
                status: 'running',
                pid: processHandle.pid || null,
                startedAt: new Date().toISOString(),
                cwd: workingDirectory,
                canvasPath: canvasPath || null
            });

            const timeout = setTimeout(() => {
                timedOut = true;
                processHandle.kill('SIGTERM');
            }, timeoutMilliseconds());

            processHandle.onData(chunk => {
                output += chunk;
                host.output('codex-exec-process', chunk);
            });

            processHandle.onExit(({ exitCode, signal }) => {
                clearTimeout(timeout);

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
                resolve(output.trim());
            });

            if (typeof processHandle.on === 'function') {
                processHandle.on('error', error => {
                    clearTimeout(timeout);
                    setStatus({ status: 'error', error: error.message });
                    reject(error);
                });
            }
        })
    };
};

module.exports = {
    CodexAgent,
    configureCodexAgent
};
