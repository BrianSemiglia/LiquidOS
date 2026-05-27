const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { copySkillsTreeToRoot } = require('./skills');

let host = {
    output: () => {},
    status: () => {}
};

const timeoutMilliseconds = () => Number.parseInt('300000', 10);
const command = 'pi';

const commandInstalled = () => {
    if (path.isAbsolute(command)) {
        return fs.existsSync(command);
    }

    return String(process.env.PATH || '')
        .split(path.delimiter)
        .some(directory => directory && fs.existsSync(path.join(directory, command)));
};

const configurePiAgent = nextHost => {
    host = {
        output: typeof nextHost?.output === 'function' ? nextHost.output : host.output,
        status: typeof nextHost?.status === 'function' ? nextHost.status : host.status
    };
};

const piRuntimePaths = ({ runtimePath } = {}) => [
    runtimePath ? path.join(runtimePath, '.pi') : null,
    runtimePath ? path.join(runtimePath, '.agents') : null
].filter(Boolean);

const materializePiRuntime = ({ runtimePath, skillsPath } = {}) => {
    const runtimePaths = piRuntimePaths({ runtimePath });

    runtimePaths.forEach(runtimePath => {
        copySkillsTreeToRoot(skillsPath, runtimePath);
    });

    return runtimePaths;
};

const conversationHistorySkillPath = () => {
    const runtimePath = process.env.LIQUIDOS_AGENT_RUNTIME_PATH;
    return runtimePath ? path.join(runtimePath, '.pi', 'skills', 'conversation-history-and-undo') : null;
};

const extractMessageText = message => {
    if (!message || typeof message !== 'object') {
        return '';
    }

    if (typeof message.text === 'string') {
        return message.text;
    }

    if (!Array.isArray(message.content)) {
        return '';
    }

    return message.content
        .map(part => part && typeof part.text === 'string' ? part.text : '')
        .join('');
};

const stripAnsi = value => String(value || '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\r/g, '');

const PiAgent = () => {
    const currentDebug = {
        kind: 'pi',
        label: 'Pi',
        command,
        status: 'waiting',
        provider: 'pi-coding-agent',
        model: null,
        source: 'pi'
    };

    const setStatus = next => {
        Object.assign(currentDebug, next, { at: new Date().toISOString() });
        host.status({ ...currentDebug });
    };

    const parseJsonLines = (chunk, carry, onLine) => {
        let buffer = carry + String(chunk || '');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim().replace(/\r$/, '');

            if (!trimmed) {
                continue;
            }

            try {
                onLine(JSON.parse(trimmed));
            } catch (error) {
                host.output('pi-rpc-process', line + '\n');
            }
        }

        return buffer;
    };

    return {
        kind: 'pi',
        label: 'Pi',
        command,
        configureHost: configurePiAgent,
        isInstalled: () => commandInstalled(),
        initialize: ({ workingDirectory } = {}) => setStatus({
            status: 'waiting',
            cwd: workingDirectory || null
        }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: prompt => prompt,
        runtimePaths: piRuntimePaths,
        materializeRuntime: materializePiRuntime,
        run: (prompt, { workingDirectory } = {}) => new Promise((resolve, reject) => {
            if (!workingDirectory) {
                reject(new Error('PiAgent.run requires a workingDirectory'));
                return;
            }

            let output = '';
            let errorOutput = '';
            let timedOut = false;
            let settled = false;
            let carry = '';
            let promptAccepted = false;
            const skillPath = conversationHistorySkillPath();
            const args = [
                '--skill',
                skillPath,
                '--mode',
                'rpc',
                '--no-session',
                '--verbose'
            ].filter(Boolean);
            const processHandle = spawn(command, args, {
                cwd: workingDirectory,
                env: process.env,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            setStatus({
                status: 'running',
                pid: processHandle.pid || null,
                startedAt: new Date().toISOString(),
                cwd: workingDirectory
            });

            const finish = (error, result) => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timeout);

                try {
                    processHandle.kill('SIGTERM');
                } catch (killError) {
                    // ignore
                }

                if (error) {
                    reject(error);
                    return;
                }

                resolve(result);
            };

            const timeout = setTimeout(() => {
                timedOut = true;
                processHandle.kill('SIGTERM');
            }, timeoutMilliseconds());

            processHandle.stdout.on('data', chunk => {
                carry = parseJsonLines(chunk, carry, event => {
                    if (event && event.type === 'response' && event.command === 'prompt') {
                        if (!event.success) {
                            finish(new Error(event.error || 'Pi rejected the prompt.'));
                            return;
                        }

                        promptAccepted = true;
                        return;
                    }

                    if (event && event.type === 'message_update' && event.assistantMessageEvent && event.assistantMessageEvent.type === 'text_delta') {
                        const delta = String(event.assistantMessageEvent.delta || '');
                        output += delta;
                        host.output('pi-rpc-process', delta);
                        return;
                    }

                    if (event && event.type === 'agent_end') {
                        const finalText = output.trim() || (Array.isArray(event.messages) ? event.messages.map(extractMessageText).join('').trim() : '');
                        finish(null, finalText);
                    }
                });
            });

            processHandle.stderr.on('data', chunk => {
                errorOutput += chunk;
                host.output('pi-rpc-process', chunk, process.stderr);
            });

            processHandle.on('close', (exitCode, signal) => {
                clearTimeout(timeout);

                if (settled) {
                    return;
                }

                if (timedOut) {
                    setStatus({ status: 'timed out', signal });
                    reject(new Error('Pi timed out after ' + timeoutMilliseconds() + 'ms'));
                    return;
                }

                if (!promptAccepted) {
                    setStatus({ status: 'failed', exitCode, signal });
                    reject(new Error(stripAnsi(errorOutput || output).trim() || 'Pi failed before accepting the prompt.'));
                    return;
                }

                if (exitCode !== 0) {
                    setStatus({ status: 'failed', exitCode, signal });
                    reject(new Error(stripAnsi(errorOutput || output).trim() || 'Pi exited with code ' + exitCode));
                    return;
                }

                setStatus({ status: 'waiting', exitCode, signal });
                resolve(output.trim());
            });

            processHandle.on('error', error => {
                clearTimeout(timeout);
                setStatus({ status: 'error', error: error.message });
                reject(error);
            });

            processHandle.stdin.write(JSON.stringify({
                type: 'prompt',
                message: String(prompt || '')
            }) + '\n');
        })
    };
};

module.exports = {
    PiAgent,
    configurePiAgent
};
