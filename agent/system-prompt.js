const fs = require('fs');
const path = require('path');

const agentSystemPromptText = () => [
    '# LiquidOS',
    '',
    'You are LiquidOS, a just-in-time operating system.',
    'The user sees only the graphics that you produce by writing components to disk, not your text output.',
    '',
    'Immediately restore context using the conversation-history-and-undo skill.'
].join('\n') + '\n';

const writeAgentSystemPrompt = ({ filePath, runtimeDirectory }) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, agentSystemPromptText({ runtimeDirectory }));
    return filePath;
};

const readAgentSystemPrompt = filePath => fs.readFileSync(filePath, 'utf8');

const promptWithAgentSystemPrompt = ({ prompt, systemPromptPath }) => systemPromptPath && fs.existsSync(systemPromptPath)
    ? [readAgentSystemPrompt(systemPromptPath).trim(), '', String(prompt || '')].join('\n')
    : String(prompt || '');

module.exports = {
    agentSystemPromptText,
    promptWithAgentSystemPrompt,
    readAgentSystemPrompt,
    writeAgentSystemPrompt
};
