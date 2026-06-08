const { createGitTimeline } = require('./git-timeline');

const restoreContextBlockPattern = /\[\[LIQUIDOS_RESTORE_CONTEXT_BEGIN\]\]([\s\S]*?)\[\[LIQUIDOS_RESTORE_CONTEXT_END\]\]/g;

const collapseWhitespace = text => String(text || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const stripRestoreContextBlocks = text => collapseWhitespace(String(text || '').replace(restoreContextBlockPattern, ''));

const extractRestoreContextBlocks = text => {
    const blocks = [];
    const source = String(text || '');
    let match;

    while ((match = restoreContextBlockPattern.exec(source)) !== null) {
        blocks.push(match[1].trim());
    }

    restoreContextBlockPattern.lastIndex = 0;
    return blocks;
};

const parseActivityPersistence = text => {
    const source = String(text || '');
    const restoreContext = extractRestoreContextBlocks(source);
    const persistedAgentResponse = stripRestoreContextBlocks(source);

    return {
        rawAgentResponse: source,
        persistedAgentResponse,
        restoreContext,
        hasRestoreContext: restoreContext.length > 0,
        hasPersistentBody: persistedAgentResponse.length > 0
    };
};

const createActivityPersistence = ({ workspacePath, currentCanvasPath, logServer }) => {
    const timeline = createGitTimeline({
        workspacePath,
        currentCanvasPath,
        logServer
    });

    const persistActivity = ({
        event = null,
        scope = null,
        prompt = '',
        agentResponse = '',
        mode = 'done',
        error = '',
        reason = ''
    } = {}) => {
        const parsed = parseActivityPersistence(agentResponse);
        const record = {
            event,
            scope,
            prompt,
            rawAgentResponse: parsed.rawAgentResponse,
            persistedAgentResponse: parsed.persistedAgentResponse,
            restoreContext: parsed.restoreContext
        };

        if (mode === 'failed') {
            timeline.commitFailedCanvases(record, parsed.persistedAgentResponse, error);
        } else if (mode === 'shutdown') {
            timeline.commitShutdownCanvases(record, reason);
        } else {
            timeline.commitCanvases(record, parsed.persistedAgentResponse);
        }

        return {
            ...parsed,
            event,
            scope,
            prompt,
            record,
            mode
        };
    };

    return {
        ensureActivityPersistenceRepo: timeline.ensureCanvasesGitRepo,
        persistActivity
    };
};

module.exports = {
    createActivityPersistence
};
