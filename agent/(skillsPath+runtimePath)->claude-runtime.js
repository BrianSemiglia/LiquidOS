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

const truncate = (value, max = 200) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 3) + '...' : text;
};

const toolInputSummary = input => {
    if (!input || typeof input !== 'object') {
        return '';
    }

    const preferred = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.prompt;
    return truncate(preferred != null ? preferred : JSON.stringify(input));
};

const textFromToolResult = content => {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map(part => (part && typeof part === 'object' && typeof part.text === 'string') ? part.text : '')
            .filter(Boolean)
            .join(' ');
    }

    return '';
};

// Turns the `claude -p --output-format stream-json` JSONL firehose into clean,
// human-readable lines: assistant text, tool calls, tool results, and a final
// done/error line. Everything else (session bookkeeping) is dropped.
const createClaudeStreamParser = userEmit => {
    const toolNames = new Map();
    let buffer = '';
    let assistantText = '';
    let finalResult = '';
    let transcript = '';

    // The emit chain: parser internals call `emit`, which both forwards to
    // the runtime's display callback (live stdout / SSE) and appends to the
    // captured transcript. The transcript is what gets persisted to git so
    // the full "Agent Response" — tool calls, tool results, text — survives.
    const emit = text => {
        if (text == null) return;
        const value = String(text);
        transcript += (transcript ? '\n' : '') + value;
        userEmit(value);
    };

    const handleEvent = event => {
        if (!event || typeof event !== 'object') {
            return;
        }

        if (event.type === 'system') {
            if (event.subtype === 'init' && event.model) {
                emit('[session] ' + event.model);
            }
            return;
        }

        if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
            event.message.content.forEach(block => {
                if (!block || typeof block !== 'object') {
                    return;
                }

                if (block.type === 'text' && block.text) {
                    assistantText += (assistantText ? '\n' : '') + block.text;
                    emit(block.text);
                    return;
                }

                if (block.type === 'tool_use') {
                    if (block.id && block.name) {
                        toolNames.set(block.id, block.name);
                    }

                    const summary = toolInputSummary(block.input);
                    emit('> ' + (block.name || 'tool') + (summary ? ' ' + summary : ''));
                }
            });
            return;
        }

        if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
            event.message.content.forEach(block => {
                if (!block || typeof block !== 'object' || block.type !== 'tool_result') {
                    return;
                }

                const name = toolNames.get(block.tool_use_id) || 'tool';
                const preview = truncate(textFromToolResult(block.content));
                emit('< ' + name + (block.is_error ? ' [error]' : '') + (preview ? ' ' + preview : ''));
            });
            return;
        }

        if (event.type === 'result') {
            if (typeof event.result === 'string' && event.result.trim()) {
                finalResult = event.result;
            }

            if (event.is_error || (event.subtype && event.subtype !== 'success')) {
                emit('[error] ' + (event.subtype || 'failed') + (event.result ? ': ' + truncate(event.result) : ''));
                return;
            }

            const parts = [];

            if (Number.isFinite(event.num_turns)) {
                parts.push(event.num_turns + ' turn' + (event.num_turns === 1 ? '' : 's'));
            }

            if (Number.isFinite(event.duration_ms)) {
                parts.push(event.duration_ms + 'ms');
            }

            emit('[done]' + (parts.length ? ' ' + parts.join(', ') : ''));
        }
    };

    const handleLine = line => {
        const trimmed = String(line).trim();

        if (!trimmed) {
            return;
        }

        let event;

        try {
            event = JSON.parse(trimmed);
        } catch (error) {
            emit(trimmed);
            return;
        }

        handleEvent(event);
    };

    return {
        push(chunk) {
            buffer += chunk;

            let index;

            while ((index = buffer.indexOf('\n')) !== -1) {
                handleLine(buffer.slice(0, index));
                buffer = buffer.slice(index + 1);
            }
        },
        flush() {
            if (buffer.trim()) {
                handleLine(buffer);
            }

            buffer = '';
        },
        result() {
            return finalResult || assistantText;
        },
        transcript() {
            return transcript;
        }
    };
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
            const parser = createClaudeStreamParser(text => {
                const value = String(text == null ? '' : text);

                if (value.trim()) {
                    host.output('claude-code-process', value.endsWith('\n') ? value : value + '\n');
                }
            });
            const processHandle = spawn(command, [
                '-p',
                prompt,
                '--verbose',
                '--output-format',
                'stream-json',
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

            processHandle.stdout.setEncoding('utf8');
            processHandle.stdout.on('data', chunk => {
                output += chunk;
                parser.push(chunk);
            });

            processHandle.on('close', (exitCode, signal) => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                }

                parser.flush();

                if (timedOut) {
                    setStatus({ status: 'timed out', signal });
                    reject(new Error('Claude Code timed out after ' + timeoutMilliseconds() + 'ms'));
                    return;
                }

                if (exitCode !== 0) {
                    setStatus({ status: 'failed', exitCode, signal });
                    reject(new Error(String(errorOutput || parser.result() || output || '').trim() || ('Claude Code exited with code ' + exitCode)));
                    return;
                }

                setStatus({ status: 'waiting', exitCode, signal });
                resolve(parser.transcript() || output);
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
