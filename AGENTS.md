# AGENTS.md — for coding agents editing this repo

This file is for AI coding agents working **on the LiquidOS harness** (this repo). It is not the runtime-agent system prompt — that lives at `skills/AGENTS.md` and is loaded into the LLM that drives a user's workspace.

## What this repo is

LiquidOS is a generative-UI host: a Node HTTP server (`server.js`) + a single-page browser shell (`index.html`) that together render and live-edit a `.liquidos` *workspace* containing canvases, components, and relationships. Workspaces are user data, not part of this repo. The harness watches workspace files, ships them to the browser through `/input` + SSE, and dispatches a coding agent (Claude Code / Codex / Hermes / Pi) when the user prompts.

There is no build step, no bundler, no transpiler, no test framework. `npm install` and `node server.js`.

## Layout

```
server.js                 single ~86KB file — all HTTP routes + harness orchestration
index.html                single ~193KB file — the entire browser shell
canvas/                   server-side: graph, files, activity persistence, output queue, prompt builder, libp2p network
agent/                    runtime adapters per coding-agent kind; filenames encode constructor signature ((args)->name.js)
lib/                      browser-side helpers (cssLayout) + custom elements (<liquidos-component>, <liquidos-file>, <liquidos-callback>)
skills/                   shipped to the workspace at runtime; read by the runtime LLM agent — editing here changes runtime behavior
workspace/                workspace bootstrap (gitignore + initial layout)
scripts/                  one-off seed data and the skills validator
diagnostics/              shell utilities placed on PATH for runtime agents (e.g. `processes`)
mac-app/                  Swift wrapper + build/ (a synced COPY of the repo — never edit there)
notes/                    historical design docs; not authoritative
```

## Running it

```sh
node server.js --workspace /path/to/Workspace.liquidos --agent hermes --port 3000
```

All three flags are required. Optional: `--agent-timeout-ms <n>`. The server does not create workspaces — the Mac app or the user does.

## Tests

Tests are Playwright probes, one file per behavior:

```
skills/testing/scripts/probe-<name>.mjs
```

Each probe is self-contained: it spawns its own sandbox via `boot-workspace-sandbox.mjs` (which copies a fixture + boots a fresh server on a random port), drives headless Chromium, asserts on user-visible DOM, and exits non-zero on failure. There is no runner — invoke directly.

```sh
node skills/testing/scripts/probe-canvas-build.mjs
```

Run the whole suite in parallel — probes use independent sandboxes:

```sh
ls skills/testing/scripts/probe-*.mjs | xargs -P 6 -I{} /opt/homebrew/bin/gtimeout 180 node {}
```

macOS has no `timeout`; use `/opt/homebrew/bin/gtimeout` by absolute path (xargs strips PATH).

Fixtures under `skills/testing/fixtures/<name>.liquidos/` are real workspaces — treat them as data, not throwaway scaffolding.

## Conventions and gotchas

- **Node-side is CommonJS, browser-side is ES modules.** `server.js` and `canvas/*.js` use `require`; `index.html`, `lib/*.js`, and the browser-loaded `canvas.js` in fixtures use `import`. Don't migrate either side.
- **`agent/` filenames encode the constructor signature.** Examples: `(workspacePath+runtimePath+skillsPath)->runtimes.js`, `(skillsPath+runtimePath)->codex-runtime.js`. The arrow and parens are intentional; don't "fix" them.
- **`skills/AGENTS.md` is the LLM system prompt** for the runtime agent inside a workspace. Edits there change agent behavior, not repo behavior.
- **`mac-app/build/`** contains a synced copy of `index.html`, `server.js`, `lib/`, `skills/`, etc. Never edit there — edit the repo root and rebuild the app.
- **Don't read deprecation into section dividers.** `// The legacy harness routes below are unchanged.` (server.js:1136) marks the new-shape vs. classic split, not dead code.
- **Routes that look unused may be probe-only.** Before deleting any route, grep `skills/testing/scripts/`. `/network/status` and `/network/dial` are the canonical example: explicit test affordances, no UI caller.
- **Pruning is a habit here.** Recent commits regularly delete dead routes, exports, and vestiges. When you find something orphaned, the user wants it gone — confirm zero callers across `*.js`, `*.mjs`, `*.html`, `*.md`, `*.sh`, then propose deletion.
- **The harness owns process lifecycle.** Don't spawn services from a probe; let the server's `newShapeServices` map track them. Don't launch the canvas watcher manually — `services/start.sh` and the app do that.
- **One source of truth for the UI loop.** Workspace files mutate → fs watcher → server broadcasts on SSE → `/input` re-fetch → browser morphs DOM. No polling, no client-side intervals, no focus/visibility re-fetch. Push-based.

## When in doubt

- For repo-editing tasks: this file, the README, and `git log` are the references. Recent commits are unusually informative.
- For workspace/runtime behavior: `skills/<area>/SKILL.md` documents the contract the runtime agent operates against.
- For the wiring contract between components and relationships: `skills/relationships/SKILL.md` is the spec; `index.html` `wireIO` (search the function name) is the implementation.
