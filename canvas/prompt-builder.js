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

// Per-job prompt carries only Scope and Prompt. Standing guidance
// (skill usage, "user only sees the canvas", don't-read-outside, etc.)
// lives in AGENTS.md, which is materialized into the workspace at
// startup and discovered by each agent via its native mechanism (or
// prepended by promptWithAgentSystemPrompt for agents that don't).
const createPromptBuilder = ({
    getCanvasPath,
    callbackPromptText
}) => {
    const buildJobPrompt = job => [
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
