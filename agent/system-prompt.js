// AGENTS.md is the source of truth for the agent's system prompt. The
// file ships with the app bundle; this module copies it into the
// workspace at startup and reads it back when an agent (e.g. hermes)
// can't discover AGENTS.md natively from CWD.

const fs = require('fs');
const path = require('path');

const SOURCE_AGENTS_MD_PATH = path.join(__dirname, '..', 'skills', 'AGENTS.md');

const writeAgentSystemPrompt = ({ filePath }) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.copyFileSync(SOURCE_AGENTS_MD_PATH, filePath);
    return filePath;
};

const readAgentSystemPrompt = filePath => fs.readFileSync(filePath, 'utf8');

const promptWithAgentSystemPrompt = ({ prompt, systemPromptPath }) => systemPromptPath && fs.existsSync(systemPromptPath)
    ? [readAgentSystemPrompt(systemPromptPath).trim(), '', String(prompt || '')].join('\n')
    : String(prompt || '');

module.exports = {
    SOURCE_AGENTS_MD_PATH,
    promptWithAgentSystemPrompt,
    readAgentSystemPrompt,
    writeAgentSystemPrompt
};
