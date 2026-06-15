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
        .chat {
            display: flex;
            flex-direction: column;
            min-width: 280px;
            max-width: 100%;
            height: 440px;
            background: #0f1117;
            border-radius: 14px;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: #e6e8ee;
        }
        .chat__header {
            padding: 12px 16px;
            font-size: 0.95rem;
            font-weight: 600;
            letter-spacing: 0.02em;
            background: #151823;
            border-bottom: 1px solid #232838;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .chat__dot {
            width: 8px; height: 8px;
            border-radius: 50%;
            background: #46d18a;
            box-shadow: 0 0 8px #46d18a;
        }
        .chat__log {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .msg {
            max-width: 82%;
            padding: 9px 13px;
            border-radius: 14px;
            line-height: 1.45;
            font-size: 0.92rem;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .msg--user {
            align-self: flex-end;
            background: #3a6df0;
            color: #fff;
            border-bottom-right-radius: 4px;
        }
        .msg--bot {
            align-self: flex-start;
            background: #1d2230;
            color: #dfe3ee;
            border-bottom-left-radius: 4px;
        }
        .chat__composer {
            display: flex;
            gap: 8px;
            padding: 12px;
            background: #151823;
            border-top: 1px solid #232838;
        }
        .chat__composer input {
            flex: 1;
            min-width: 0;
            padding: 10px 12px;
            border-radius: 10px;
            border: 1px solid #2b3145;
            background: #0f1117;
            color: #e6e8ee;
            font-size: 0.92rem;
            outline: none;
        }
        .chat__composer input:focus { border-color: #3a6df0; }
        .chat__composer button {
            padding: 10px 16px;
            border-radius: 10px;
            border: none;
            background: #3a6df0;
            color: #fff;
            font-weight: 600;
            cursor: pointer;
            font-size: 0.92rem;
        }
        .chat__composer button:hover { background: #2f5ad6; }
    </style>
    <div class="chat">
        <div class="chat__header"><span class="chat__dot"></span>Chat with LiquidOS</div>
        <div class="chat__log" id="chat-log"></div>
        <liquidos-callback on="submit" scope="components/${safe_name}" values="message" prompt="The user sent this message in the chat: {{message}}. The whole conversation is already in #chat-log — read it there for context (including any 'this/that' references) before you reply. Append their message as a .msg--user bubble and your reply as a .msg--bot bubble to #chat-log. If the message asks to change the canvas or workspace, do that first, then append a short .msg--bot bubble saying what changed.">
            <form class="chat__composer" autocomplete="off">
                <input name="message" placeholder="Type a message…" required>
                <button type="submit">Send</button>
            </form>
        </liquidos-callback>
        <liquidos-file path="components/${safe_name}/scroll.js" script></liquidos-file>
    </div>
</liquidos-component>
HTML

# scroll.js -----------------------------------------------------------------
cat > "$component_dir/scroll.js" <<'JS'
// Keeps #chat-log pinned to the newest message: scrolls to the bottom on
// mount and whenever bubbles are appended or bot text streams in.
export function mount(surface) {
    const log = surface.querySelector('#chat-log');
    if (!log) return;

    const toBottom = () => { log.scrollTop = log.scrollHeight; };
    toBottom();

    const observer = new MutationObserver(toBottom);
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
