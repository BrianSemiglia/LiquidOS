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
        'Immediately restore context using the conversation-history-and-undo skill.',
        '',
        'Scope:',
        scopeText(job.scope, getCanvasPath),
        '',
        'Request:',
        callbackPromptText(job)
    ].join('\n');

    return {
        buildJobPrompt
    };
};

module.exports = {
    createPromptBuilder
};
