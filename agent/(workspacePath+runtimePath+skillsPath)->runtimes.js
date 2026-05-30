const fs = require('fs');
const path = require('path');
const { writeAgentSystemPrompt } = require('./system-prompt');
const { HermesAgent } = require('./(skillsPath+runtimePath)->hermes-runtime');
const { PiAgent } = require('./(skillsPath+runtimePath)->pi-runtime');
const { CodexAgent } = require('./(skillsPath+runtimePath)->codex-runtime');
const { ClaudeCodeAgent } = require('./(skillsPath+runtimePath)->claude-runtime');

// NoneAgent is for runs that should not have a working agent — sandbox boots
// for smoke tests, recursion guards, anything where callbacks should fail
// loudly rather than dispatching a real prompt. Callbacks will reject; static
// rendering, services, and view.json watching still work.
const NoneAgent = () => ({
    kind: 'none',
    label: 'No agent',
    command: null,
    configureHost: () => {},
    isInstalled: () => true,
    initialize: () => {},
    dispose: () => {},
    currentDebug: () => ({ status: 'no agent configured' }),
    runtimePaths: () => [],
    materializeRuntime: () => {},
    preparePrompt: prompt => prompt,
    run: () => Promise.reject(new Error('No agent is configured (--agent none).'))
});

const createRuntimes = ({
    workspacePath,
    runtimePath,
    skillsPath
} = {}) => {
    if (!workspacePath || !runtimePath || !skillsPath) {
        throw new Error('createRuntimes requires workspacePath, runtimePath, and skillsPath');
    }

    const runtimeLogsPath = path.join(runtimePath, 'logs');
    const runtimePromptPath = path.join(runtimePath, 'AGENTS.md');
    const runtimeConfigPath = path.join(runtimePath, 'runtime.json');

    const runtimes = [
        HermesAgent(),
        PiAgent(),
        CodexAgent(),
        ClaudeCodeAgent(),
        NoneAgent()
    ];

    const materializeRuntime = () => {
        if (!fs.existsSync(skillsPath)) {
            return false;
        }

        fs.mkdirSync(runtimePath, { recursive: true });
        fs.mkdirSync(runtimeLogsPath, { recursive: true });

        fs.readdirSync(runtimePath)
            .filter(name => !['logs', 'runtime.json'].includes(name))
            .forEach(name => fs.rmSync(path.join(runtimePath, name), { recursive: true, force: true }));

        runtimes.forEach(runtime => {
            if (runtime && typeof runtime.materializeRuntime === 'function') {
                runtime.materializeRuntime({
                    runtimePath,
                    skillsPath
                });
            }
        });

        writeAgentSystemPrompt({
            filePath: runtimePromptPath,
            runtimeDirectory: runtimePath
        });

        return true;
    };

    const writeRuntimeConfig = () => {
        fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
        fs.writeFileSync(
            runtimeConfigPath,
            JSON.stringify({ app: workspacePath }, null, 2) + '\n'
        );
    };

    const refreshRuntime = () => {
        materializeRuntime();
        writeRuntimeConfig();
        process.env.LIQUIDOS_AGENT_RUNTIME_PATH = runtimePath;
    };

    const configureHosts = ({ output, status } = {}) => {
        runtimes.forEach(runtime => {
            runtime.configureHost({
                output,
                status
            });
        });
    };

    return {
        runtimes,
        runtimePath,
        runtimeLogsPath,
        runtimePromptPath,
        runtimeConfigPath,
        refreshRuntime,
        configureHosts
    };
};

module.exports = {
    createRuntimes
};
