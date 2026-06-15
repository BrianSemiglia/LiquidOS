---
name: chat
description: Talk to the user by putting a chat on the canvas
triggers:
  - You need to say something to the user (your text output isn't shown)
  - You need to ask the user a question conversationally
  - User asks to open or use a chat
---

# Chat

The user never sees your text output — to hold a conversation, put a chat on the canvas.

Scaffold a working one in one shot:

`bash skills/chat/scripts/create-chat.sh <canvas-path> [name]`

It builds a styled message log (`#chat-log`), a composer wired to a `<liquidos-callback on="submit">` that sends each message back to you, and auto-scroll — then registers it on the canvas and hands you an empty log to stream into. Name defaults to `chat`.

Then:

- **Open the conversation** — stream your first line in as a `.msg--bot` bubble appended to `#chat-log` (one bubble per patch).
- **Each later user message** arrives as a prompt. Append their `.msg--user` bubble and your `.msg--bot` reply to `#chat-log`. The whole conversation lives in `#chat-log` — read it for context (including "this/that" references) before replying.
- **A message can be a request** to change the canvas or workspace. Do the work, then append a short `.msg--bot` bubble saying what changed.

A chat is implemented as an ordinary component under `components/<name>/`, so the component skill applies (streaming rules, diagnostics, portability) — but that's a detail. Reach for this whenever you need to talk to the user.
