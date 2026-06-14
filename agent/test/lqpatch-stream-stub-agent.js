// Test agent for the lqpatch streaming probe.
//
// Real Claude's job for this flow: receive a prompt, stream a mix of
// prose and <lqpatch> markers via host.output, where one of the markers
// is op="writeFile" that lands a file change on a component. The stub
// does exactly that deterministically — same wire shape, no LLM.
//
// The agent reads "REPLACE_WITH: <token>" from the prompt and emits a
// script that:
//   - narrates briefly,
//   - dispatches an atomic op (replace) into the page's #lqpatch-sink
//     so the sniffer's structural-op path is exercised,
//   - streams a known token into #lqpatch-sink via op="stream" so the
//     streaming-op path is exercised (probe observes chunked arrival),
//   - writes a new component.html via op="writeFile" carrying the token,
//   - narrates a closing line so the probe's end-flush regression
//     assertion still applies.
//
// Used by skills/testing/scripts/probe-lqpatch-stream-component-edit.mjs.

let host = { output: () => {}, status: () => {} };
const KIND = 'lqpatch-stream-stub';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const extractToken = (prompt) => {
    const m = String(prompt || '').match(/REPLACE_WITH:\s*(\S+)/);
    return m ? m[1] : '';
};

// Pause briefly between chunks so the client-side MutationObserver and
// EventSource handlers see distinct events rather than collapsing the
// whole script into one synchronous burst.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const LqpatchStreamStubAgent = () => {
    const currentDebug = {
        kind: KIND,
        label: 'lqpatch stream (stub)',
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
        label: 'lqpatch stream (stub)',
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
        run: async (prompt, context = {}) => {
            const workingDirectory = context.workingDirectory || context.canvasPath;
            if (!workingDirectory) {
                throw new Error(KIND + ': run requires workingDirectory');
            }
            const scope = extractScope(prompt);
            const token = extractToken(prompt);
            if (!token) {
                throw new Error(KIND + ': prompt missing "REPLACE_WITH: <value>"');
            }
            setStatus({ status: 'running', cwd: workingDirectory });

            // The script the stub emits — same shape as the experiment's
            // stub stream, but using #lqpatch-sink (which exists in the
            // live index.html) and adding an op="writeFile" against the
            // fixture's component.html. The writeFile path is hardcoded to
            // match the agent-edit-stub fixture; the prompt's REPLACE_WITH
            // token is what threads through to disk so the probe can
            // prove the prompt-to-stream-to-disk wire.
            // PERSIST_MARK proves that DOM ops against elements inside a
            // <liquidos-component> are written back to the component's
            // component.html on disk. The probe replaces #target-status's
            // text, then reads target/component.html and asserts the
            // mark is there. Lives inside a real component (unlike the
            // page-chrome #lqpatch-sink), so the persistence layer has a
            // host to serialize.
            const PERSIST_MARK = 'PERSISTED_' + token;
            const filePath = 'home/components/target/component.html';
            // Both edits the user's prompt triggers — the status replacement
            // and this file rewrite — must show the same thing, so the user
            // sees one consistent result, not one edit flashing over the other.
            const fileBody = '<liquidos-component path="components/target">\n    <p data-marker>' + token + '</p>\n    <div id="target-status">' + PERSIST_MARK + '</div>\n</liquidos-component>\n';
            const STREAM_TEXT = 'The quick brown fox jumps over ' + token + '.';

            // INVENTED_TAG goes inside #lqpatch-marker (which the first
            // replace just created). Proves the agent can invent its own
            // selectors and target them in the same stream — the central
            // claim of the streaming-into-just-created-elements story.
            const INVENTED_TAG = 'invented-' + token;
            const script =
                "Here's a small build.\n\n" +
                "First, replace the sink contents:\n\n" +
                '<lqpatch target="#lqpatch-sink" op="replace">' +
                '<div id="lqpatch-marker">START</div>' +
                '</lqpatch>' +
                "\n\nNow stream some text in:\n\n" +
                '<lqpatch target="#lqpatch-sink" op="stream">' +
                STREAM_TEXT +
                '</lqpatch>' +
                "\n\nAppend into the marker I just created (with a newline mid-tag — regression for the parser's tolerance of LLM-introduced whitespace inside the open):\n\n" +
                '<lqpat\nch target="#lqpatch-marker" op="append">' +
                '<span class="agent-invented" data-tag="' + INVENTED_TAG + '">' +
                INVENTED_TAG +
                '</span>' +
                '</lqpat\nch>' +
                "\n\nReplace the status inside the target component (persistence regression — should land in component.html on disk):\n\n" +
                '<lqpatch target="#target-status" op="replace">' +
                '<span>' + PERSIST_MARK + '</span>' +
                '</lqpatch>' +
                "\n\nFinally, write the component file:\n\n" +
                '<lqpatch target="' + filePath + '" op="writeFile">' +
                fileBody +
                '</lqpatch>' +
                "\n\nDone!";

            // Chunk small enough to straddle markers — proves the sniffer
            // handles partial open/close tags across host.output calls.
            const CHUNK = 16;
            try {
                for (let i = 0; i < script.length; i += CHUNK) {
                    host.output(KIND, script.slice(i, i + CHUNK));
                    await sleep(15);
                }
                setStatus({ status: 'waiting' });
                return 'ok';
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                throw error;
            }
        }
    };
};

module.exports = { LqpatchStreamStubAgent };
