const fs = require('fs');
const path = require('path');
const { writeAgentSystemPrompt } = require('./system-prompt');
const { HermesAgent } = require('./(skillsPath+runtimePath)->hermes-runtime');
const { PiAgent } = require('./(skillsPath+runtimePath)->pi-runtime');
const { CodexAgent } = require('./(skillsPath+runtimePath)->codex-runtime');
const { ClaudeCodeAgent } = require('./(skillsPath+runtimePath)->claude-runtime');

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
        ClaudeCodeAgent()
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
