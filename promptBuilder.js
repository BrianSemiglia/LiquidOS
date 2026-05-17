const path = require('path');

const scopeText = (scope, getCanvasPath) => {
    const value = String(scope || '').trim();

    if (!value || value === '.' || value === './') {
        return getCanvasPath();
    }

    return path.isAbsolute(value) ? path.normalize(value) : path.resolve(getCanvasPath(), value.replace(/^\.\//, ''));
};

const createPromptBuilder = ({
    getCanvasPath,
    callbackPromptText
}) => {
    const buildJobPrompt = job => [
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
