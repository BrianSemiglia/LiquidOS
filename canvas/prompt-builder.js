const path = require('path');

const scopeText = (scope, getCanvasPath) => {
    const value = String(scope || '').trim();
    const asDirectoryPath = file => file.endsWith(path.sep) ? file : file + path.sep;

    if (!value || value === '.' || value === './') {
        return asDirectoryPath(getCanvasPath());
    }

    const resolved = path.isAbsolute(value) ? path.normalize(value) : path.resolve(getCanvasPath(), value.replace(/^\.\//, ''));
    return resolved === getCanvasPath() ? asDirectoryPath(resolved) : resolved;
};

const createPromptBuilder = ({
    getCanvasPath,
    callbackPromptText
}) => {
    const buildJobPrompt = job => [
        'Immediately restore context using the conversation-history-and-undo skill. Then use canvas/component skills to help the user. When you are done, do not summarize your work. The user does not see your text output, only the canvas. If you need to talk to the user, create a chat component.',
        'Skills can be found in: ~/Library/Application Support/LiquidOS/AgentRuntime/.codex/skills/',
        'Do not read local files outside the workspace/agentruntime unless the user asks.',
        '',
        'Scope:',
        scopeText(job.scope, getCanvasPath),
        '',
        'Prompt:',
        callbackPromptText(job)
    ].join('\n');

    return {
        buildJobPrompt
    };
};

module.exports = {
    createPromptBuilder
};
