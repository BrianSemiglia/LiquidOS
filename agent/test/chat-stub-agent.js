// Test agent for the chat skill.
//
// The chat composer dispatches each message back to the agent with a prompt
// like "The user sent this message in the chat: <message>. … Append their
// message as a .msg--user bubble and your reply as a .msg--bot bubble to
// #chat-log." A real agent reads #chat-log and replies in its own words; this
// stub does the minimum to prove the loop works end to end: it pulls the
// message out of the prompt and appends the two bubbles via <lqpatch>, so a UI
// probe can type, send, and see both land on screen.

let host = { output: () => {}, status: () => {} };
const KIND = 'chat-stub';

// The composer's prompt (see skills/chat/scripts/create-chat.sh) embeds the
// user's text as "...in the chat: <message>. FIRST, before doing anything
// else, ...". Pull it back out — keep this terminator in sync with the
// scaffold's prompt wording.
const userMessage = (prompt) => {
    const m = String(prompt || '').match(/in the chat: ([\s\S]*?)\. FIRST, before doing anything else/);
    return m ? m[1] : '';
};

const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CHAT_STUB_REPLY = 'Got it — replying in the chat.';

const ChatStubAgent = () => {
    const currentDebug = {
        kind: KIND,
        label: 'chat (stub)',
        command: null,
        status: 'waiting',
        provider: 'test',
        model: null,
        source: 'in-process'
    };
    const setStatus = (next) => {
        Object.assign(currentDebug, next, { at: new Date().toISOString() });
        host.status({ ...currentDebug });
    };
    return {
        kind: KIND,
        label: 'chat (stub)',
        command: null,
        configureHost: (next) => {
            host = {
                output: typeof next?.output === 'function' ? next.output : host.output,
                status: typeof next?.status === 'function' ? next.status : host.status
            };
        },
        isInstalled: () => true,
        initialize: ({ workingDirectory } = {}) =>
            setStatus({ status: 'waiting', cwd: workingDirectory || null }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: (prompt) => prompt,
        runtimePaths: () => [],
        materializeRuntime: () => {},
        run: async (prompt) => {
            setStatus({ status: 'running' });
            const message = escapeHtml(userMessage(prompt));
            // Append the user's message and a reply to #chat-log — the two
            // bubbles a real agent would add. One op so the two land together
            // (a real agent streams them with delays; firing both instantly
            // would race the component's persist-and-re-render cycle).
            host.output(KIND,
                '<lqpatch target="#chat-log" op="append">'
                + '<div class="msg msg--user">' + message + '</div>'
                + '<div class="msg msg--bot">' + CHAT_STUB_REPLY + '</div>'
                + '</lqpatch>', 'stdout');
            setStatus({ status: 'waiting' });
            return 'ok: replied in chat';
        }
    };
};

module.exports = { ChatStubAgent, CHAT_STUB_REPLY };
