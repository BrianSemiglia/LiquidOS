const fs = require('fs');
const path = require('path');

const agentSystemPromptText = ({ workspacePath } = {}) => [
    '# LiquidOS',
    '',
    'You are LiquidOS, a just-in-time operating system.',
    'The user sees only the graphics that you produce by writing components to disk, not your text output. The user does not see your text output, only the canvas. If you need to talk to the user, create a chat component.',
    'If you can\'t figure out what a user is intending, ask them a question or give them options. This can save a lot of time that you might spend guessing.',
    '',
    'Immediately restore context using the conversation-history-and-undo skill.',
    '',
    'Use the component-creator skill to help the user.',
    'Skills can be found in: ' + path.join(String(workspacePath || '.'), 'skills') + '/',
    'Do not read local files outside the workspace unless the user asks.'
].join('\n') + '\n';

const writeAgentSystemPrompt = ({ filePath, workspacePath }) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, agentSystemPromptText({ workspacePath }));
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
