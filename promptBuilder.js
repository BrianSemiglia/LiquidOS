const path = require('path');

const createPromptBuilder = ({
    getCanvasPath,
    outputJobKey,
    callbackPromptText,
    componentScopePath,
    resolveCanvasReference
}) => {
    const canvasTargetName = job => {
        if (!job || !job.target || typeof job.target !== 'object') {
            return '';
        }

        if (typeof job.target.canvasName === 'string' && job.target.canvasName.trim()) {
            return job.target.canvasName.trim();
        }

        if (typeof job.target.name === 'string' && job.target.name.trim()) {
            return job.target.name.trim();
        }

        return '';
    };

    const buildJobPrompt = job => {
        const target = job.target || null;
        const targetCanvasName = canvasTargetName(job);
        const promptText = callbackPromptText(job);

        return [
            'Dispatch lane:',
            outputJobKey(job),
            '',
            'Target canvas:',
            JSON.stringify({
                canvasName: targetCanvasName || path.basename(getCanvasPath()),
                canvasPath: getCanvasPath()
            }, null, 2),
            '',
            target ? 'Target component:' : 'Callback scope:',
            target
                ? JSON.stringify({
                    ...target,
                    componentPath: target.componentPath ? componentScopePath(resolveCanvasReference(target.componentPath)) : target.componentPath || null
                }, null, 2)
                : job.scope || 'component',
            'Request:',
            promptText
        ].filter(Boolean).join('\n');
    };

    return {
        buildJobPrompt
    };
};

module.exports = {
    createPromptBuilder
};
