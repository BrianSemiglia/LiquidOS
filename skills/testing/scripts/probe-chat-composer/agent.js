// Per-probe copy for probe-chat-composer — its own stub so no two probes share one.
// Test agent for the chat skill.
//
// The chat composer echoes the user's own .msg--user bubble into #chat-log on
// send and dispatches the message back to the agent. The agent's only job is to
// append its own .msg--bot reply. A real agent reads #chat-log and replies in
// its own words; this stub does the minimum to prove the loop works end to end:
// it appends a single .msg--bot bubble via <lqpatch>, so a UI probe can type,
// send, and see the user's message (from the chat) plus a reply land on screen.

let host = { output: () => {}, status: () => {} };
const KIND = 'chat-composer';

const CHAT_STUB_REPLY = 'Got it — replying in the chat.';

const ChatComposerAgent = () => {
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
            // The agent appends only its own .msg--bot reply — the chat already
            // echoed the user's .msg--user bubble into #chat-log on send.
            host.output(KIND,
                '<lqpatch target="#chat-log" op="append">'
                + '<div class="msg msg--bot">' + CHAT_STUB_REPLY + '</div>'
                + '</lqpatch>', 'stdout');
            setStatus({ status: 'waiting' });
            return 'ok: replied in chat';
        }
    };
};

module.exports = { ChatComposerAgent, CHAT_STUB_REPLY };
