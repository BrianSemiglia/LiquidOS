const path = require('path');

const createPromptBuilder = ({
    basePrompt,
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

    const buildAgentJobPrompt = job => {
        const target = job.target || null;
        const targetCanvasName = canvasTargetName(job);
        const promptText = callbackPromptText(job);

        return [
            basePrompt,
            '',
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
            '',
            'Treat the supplied scope path as your working space for this request. Keep the work contained to that scope. If you need scratch files, notes, or intermediate artifacts, create and use them inside that scope path.',
            'Canvas contract: input.json.components must be an array of string paths relative to the canvas root. Create or update a component file under components/<name>/view.json, then reference that file path from input.json. Never write inline component objects into input.json.',
            'Look up .hermes/skills/component-instance-creator-updater/SKILL.md if you need a reminder on how component creation/updating works.',
            'You should progressively update the component so the user knows whats going on. That means immediately creating or updating a component with a loading state that possibly says what youre doing. Then as you begin your work, you should update the component progressively. For example, if you are searching, you should update the component as you find search results. Then once you are complete, you should resolve the component to a resolved state, then mark your work as done and stop working.',
            'Request:',
            promptText
        ].filter(Boolean).join('\n');
    };

    return {
        buildAgentJobPrompt
    };
};

module.exports = {
    createPromptBuilder
};
