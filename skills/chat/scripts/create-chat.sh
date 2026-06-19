#!/usr/bin/env bash
set -euo pipefail

#
# create-chat.sh — scaffolds a ready-to-use chat for talking to the user.
#
# Usage:
#   bash skills/chat/scripts/create-chat.sh <canvas-path> [name]
#
# The user doesn't see your text output, so to hold a conversation you put a
# chat on the canvas. This builds the whole working thing in one shot:
#   component.html   chat frame: header, an empty #chat-log, and a composer
#                    wired to a <liquidos-callback on="submit"> whose prompt
#                    feeds the user's message back to you to answer
#   scroll.js        keeps #chat-log pinned to the newest message
#   feature-requirements.txt, diagnostics/status.json, tests/, data/
# and registers it in the canvas input.json.
#
# (A chat is implemented as an ordinary component, so the component skill
# applies — streaming, diagnostics, portability. That's an implementation
# detail; reach for this whenever you need to say something to the user.)
#
# After running it, stream your opening line in as a .msg--bot bubble appended
# to #chat-log. Every later user message arrives back as a prompt; append their
# .msg--user bubble and your .msg--bot reply to #chat-log.
#
# Output: one-line JSON describing the new chat.
#

positional=()

for arg in "$@"; do
    case "$arg" in
        --help|-h)
            echo "Usage: $0 <canvas-path> [name]"
            exit 0
            ;;
        *)
            positional+=("$arg")
            ;;
    esac
done

if [ "${#positional[@]}" -lt 1 ]; then
    echo "Usage: $0 <canvas-path> [name]" >&2
    exit 1
fi

canvas_dir="${positional[0]}"
raw_name="${positional[1]:-chat}"

if [ ! -d "$canvas_dir" ]; then
    echo "Error: canvas folder does not exist: $canvas_dir" >&2
    exit 1
fi

if [ ! -f "$canvas_dir/input.json" ]; then
    echo "Error: $canvas_dir/input.json not found (is this a canvas?)" >&2
    exit 1
fi

canvas_dir="$(cd "$canvas_dir" && pwd)"

# Sanitize name: lowercase, alphanumeric + dashes/underscores only.
safe_name="$(printf '%s' "$raw_name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"

if [ -z "$safe_name" ]; then
    echo "Error: chat name is required (got: $raw_name)" >&2
    exit 1
fi

component_dir="$canvas_dir/components/$safe_name"

if [ -e "$component_dir" ]; then
    echo "Error: a component already exists at: $component_dir" >&2
    exit 1
fi

mkdir -p "$component_dir/diagnostics" "$component_dir/tests" "$component_dir/data"
printf '{}\n' > "$component_dir/diagnostics/status.json"

# component.html ------------------------------------------------------------
# The chat frame is scaffolding (a fixed, known shape) — written here, not
# streamed. #chat-log starts empty; you stream the conversation into it. The
# composer's <liquidos-callback> dispatches each user message back to you.
cat > "$component_dir/component.html" <<HTML
<liquidos-component path="components/${safe_name}">
    <style>
        /* Mirrors the harness in escape mode: a darker outer "desk" frame
           (header + composer) wrapping a lighter "canvas" message area, with
           a prompt-bar-style input — all separated by tone, no strokes. Hardcoded
           local --c-* vars (with a light/dark media query) so it stays put if a
           future app version restyles the harness. */
        .chat {
            --c-desk: #1a1c1f;
            --c-canvas: #23262a;
            --c-input: #2c2f34;
            --c-control: #2a2d31;
            --c-accent: #d4d7dc;
            --c-accent-hover: #e6e8ec;
            --c-accent-fg: #1a1c1f;
            --c-fg: 226, 229, 233;
            --c-fg-solid: #edeff2;

            display: flex;
            flex-direction: column;
            min-width: 280px;
            max-width: 380px;
            width: 100%;
            height: 440px;
            background: var(--c-desk);
            border-radius: 16px;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
            color: var(--c-fg-solid);
        }
        @media (prefers-color-scheme: light) {
            .chat {
                --c-desk: #e9ebf0;
                --c-canvas: #ffffff;
                --c-input: #ffffff;
                --c-control: #eceef2;
                --c-accent: #3b4047;
                --c-accent-hover: #2c3037;
                --c-accent-fg: #ffffff;
                --c-fg: 38, 42, 48;
                --c-fg-solid: #22262c;
            }
        }
        .chat__header {
            padding: 0.75rem 0.75rem 0;
            font-size: 0.86rem;
            font-weight: 600;
        }
        .chat__log {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 0.9rem;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
            background: var(--c-canvas);
            /* Inset rounded card with desk columns on each side — like the
               canvas sitting in the desk in escape mode. */
            margin: 0.75rem;
            border-radius: 12px;
        }
        .msg {
            max-width: 82%;
            padding: 0.5rem 0.75rem;
            border-radius: 14px;
            line-height: 1.45;
            font-size: 0.88rem;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .msg--user {
            align-self: flex-end;
            background: var(--c-accent);
            color: var(--c-accent-fg);
            border-bottom-right-radius: 4px;
        }
        .msg--bot {
            align-self: flex-start;
            background: var(--c-control);
            color: rgba(var(--c-fg), 0.92);
            border-bottom-left-radius: 4px;
        }
        .chat__composer {
            display: flex;
            align-items: flex-end;
            gap: 0.5rem;
            padding: 0 0.75rem 0.75rem;
        }
        .chat__composer textarea {
            flex: 1;
            min-width: 0;
            /* Grows with content (same mechanism as the prompt bar): field-sizing
               lets the control size to its text, one row at rest, taller as you
               type, bounded by max-height — then it scrolls at the cap. */
            field-sizing: content;
            max-height: 6rem;
            resize: none;
            padding: 0.5rem 0.7rem;
            border-radius: 10px;
            border: none;
            background: var(--c-input);
            color: var(--c-fg-solid);
            font: inherit;
            font-size: 0.88rem;
            line-height: 1.3;
            outline: none;
        }
        .chat__composer textarea::placeholder { color: rgba(var(--c-fg), 0.4); }
        .chat__composer button {
            flex-shrink: 0;
            width: 2.1rem;
            height: 2.1rem;
            border-radius: 50%;
            border: none;
            background: var(--c-accent);
            color: var(--c-accent-fg);
            font-size: 1rem;
            line-height: 1;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .chat__composer button:hover:not(:disabled) { background: var(--c-accent-hover); }
        .chat__composer button:disabled { opacity: 0.45; cursor: default; }
    </style>
    <div class="chat">
        <div class="chat__header">Chat with LiquidOS</div>
        <div class="chat__log" id="chat-log"></div>
        <liquidos-callback on="submit" scope="components/${safe_name}" values="message" prompt="The user sent this message in the chat: {{message}}. FIRST, before doing anything else, append two bubbles to #chat-log: their message as a .msg--user bubble, then a placeholder .msg--bot bubble containing only '…' to show you're working on a reply. THEN read the whole conversation in #chat-log for context (including any 'this/that' references) and, if the message asks to change the canvas or workspace, make that change. FINALLY, replace the '…' in the placeholder .msg--bot bubble with your actual reply (for a change, a short note saying what changed).">
            <form class="chat__composer" autocomplete="off">
                <textarea name="message" aria-label="Message" rows="1" required></textarea>
                <button type="submit" aria-label="Send">↑</button>
            </form>
        </liquidos-callback>
        <liquidos-file path="components/${safe_name}/scroll.js" script></liquidos-file>
    </div>
</liquidos-component>
HTML

# scroll.js -----------------------------------------------------------------
cat > "$component_dir/scroll.js" <<'JS'
// Auto-follows new messages, but only when the user is already at the bottom:
// scrolls to the newest bubble (and tracks streaming text) as long as they
// haven't scrolled up to read history. Starts pinned on mount.
export function mount(surface) {
    const log = surface.querySelector('#chat-log');
    if (!log) return;

    // "Within a few px of the bottom" still counts as pinned, so streaming
    // text and rounding don't unpin the view.
    const THRESHOLD = 24;
    const atBottom = () =>
        log.scrollHeight - log.scrollTop - log.clientHeight <= THRESHOLD;

    let pinned = true;
    const toBottom = () => { log.scrollTop = log.scrollHeight; };
    toBottom();

    // The user scrolling up unpins; scrolling back to the bottom re-pins.
    log.addEventListener('scroll', () => { pinned = atBottom(); });

    // Composer: Send is disabled until there's text, and the input clears once
    // the agent's reply lands — kept until then so a failed turn doesn't lose
    // what the user typed.
    const input = surface.querySelector('.chat__composer textarea');
    const sendBtn = surface.querySelector('.chat__composer button[type="submit"]');
    let awaitingReply = false;
    const syncSend = () => { if (input && sendBtn) sendBtn.disabled = input.value.trim().length === 0; };
    const clearWhenReplied = () => {
        if (!awaitingReply || !input) return;
        const bots = log.querySelectorAll('.msg--bot');
        const last = bots[bots.length - 1];
        const text = last ? last.textContent.trim() : '';
        // The reply starts as a "…" placeholder; clear once real text replaces it.
        if (text && text !== '…') { input.value = ''; awaitingReply = false; syncSend(); }
    };
    if (input && sendBtn) {
        input.addEventListener('input', syncSend);
        // The composer is a textarea so it can grow with content (like the prompt
        // bar): Enter sends, Shift+Enter inserts a newline.
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (input.form && !sendBtn.disabled) input.form.requestSubmit();
            }
        });
        if (input.form) input.form.addEventListener('submit', () => { awaitingReply = true; });
        syncSend();
    }

    const observer = new MutationObserver(() => { if (pinned) toBottom(); clearWhenReplied(); });
    observer.observe(log, { childList: true, subtree: true, characterData: true });

    return () => observer.disconnect();
}
JS

# feature-requirements.txt --------------------------------------------------
cat > "$component_dir/feature-requirements.txt" <<TXT
- Chat with LiquidOS in a scrolling message log
- Type a message and send it to get a reply
- Ask LiquidOS to change the canvas or workspace from the chat
TXT

# Append components/<name>/component.html to canvas input.json (preserve every
# other key and entry; skip if already present).
node -e '
const fs = require("fs");
const [inputPath, componentPath] = process.argv.slice(1);
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
if (!Array.isArray(input.components)) input.components = [];
if (!input.components.includes(componentPath)) input.components.push(componentPath);
fs.writeFileSync(inputPath, JSON.stringify(input, null, 2) + "\n");
' "$canvas_dir/input.json" "components/$safe_name/component.html"

printf '{"chat":"%s","path":"%s"}\n' "$safe_name" "$component_dir"
