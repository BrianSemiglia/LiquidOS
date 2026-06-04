---
name: canvas-creator
description: Create a new LiquidOS canvas inside an existing .liquidos workspace
triggers:
  - User asks to create a new canvas instance
  - User wants to set up a new live canvas
  - User mentions creating a canvas
---

# Canvas Creator

Use this skill when the user asks to create a new canvas inside an existing `.liquidos` workspace.

## Current Shape

The `.liquidos` folder is the workspace root and the canvas root. A canvas is a direct child of that folder:

```text
Workspace.liquidos/
  selected-canvas.json
  home/
    input.json                — component manifest
    output.json               — agent job queue
    canvas.js                 — presentation, input controls, anything canvas-scoped
    canvas-requirements.txt   — plain-text description of what this canvas is for
    state.json                — canvas.js's persisted state (optional)
    components/               — component folders
      foo/
        state.json            — per-component canvas state (optional)
  <canvas-name>/
    input.json
    output.json
    canvas.js
    canvas-requirements.txt
    state.json
    components/
```

`input.json` is the component manifest (just `{ "components": [...] }`). `components/` contains component folders. See `../component-creator/SKILL.md` for component structure.

## Quick Start

Run from the workspace root (the agent's CWD):

```bash
bash skills/canvas-creator/scripts/create-instance.sh <canvas-name> /path/to/Workspace.liquidos
```

This creates:

```text
Workspace.liquidos/<canvas-name>/input.json
Workspace.liquidos/<canvas-name>/output.json
Workspace.liquidos/<canvas-name>/canvas.js
Workspace.liquidos/<canvas-name>/components/
```

## canvas-requirements.txt

A plain-text file at the canvas root describing what this canvas is for —
what kinds of cards it should hold, how they should be arranged, how the
user wants to feel using it. Parallel to a component's
`feature-requirements.txt`, but one layer up.

- **Optional.** Canvases work without it; an empty file is fine.
- **Read it first** when working on a canvas. If the user asks you to add
  or modify components, consult this file to understand the canvas's
  intent and keep your work aligned with it.
- **Write to it** when the user describes the canvas in a new way, or
  when you learn something about the canvas's purpose that ought to be
  recorded. Keep it concise and plain-language.
- **Don't put implementation details in it.** That's what `canvas.js`,
  `input.json`, and the component files are for. This file is intent
  only — the description should still make sense if you rebuilt every
  component from scratch.
- It is also the natural unit for "share this app" later: the canvas's
  requirements plus each component's `feature-requirements.txt` together
  describe the app completely without any code.

## Core Principle

Never modify source data when creating interfaces.

When building canvas components that reference source files, create interface components that reference or serve the originals without renaming, moving, deleting, or rewriting the source files unless the user explicitly asks.

## Loading-First Updates

When creating or updating a component instance, the first visible response should be a loading-state version of the relevant component. Keep it in place while work continues.

## Adding Components

1. Create a component folder under `components/`.
2. Ensure the component includes `feature-requirements.txt` and `view.json`.
   `feature-requirements.txt` is user-facing. Keep it plain-language, concise, and faithful to the component.
3. Add the component folder path to `input.json` if it is not already present.
4. Preserve existing `input.json` keys and component paths.

## Starting the App

Use the app/server workflow provided by the LiquidOS runtime. Do not create or copy HTML entry files for the canvas.

## canvas.js — the one module per canvas

Every canvas has exactly one `canvas.js` at its root. It owns presentation (where components live on screen), input handling (scroll, keyboard, custom gestures), and anything else canvas-scoped — recenter buttons, axis-invert toggles, scene chrome, audio context, whatever.

`input.json` is just `{ "components": [...] }` — no `presentation` field. The harness always loads `<canvas>/canvas.js`.

### Contract

```js
import { cssLayout } from '/lib/css-layout.js'; // optional, for CSS-only canvases

export default (root, context) => {
    // root: the canvas DOM region this module owns.
    // context: { canvasPath } — useful for state keys, logging, scoping.
    //
    // Build scene chrome, attach input listeners, hold camera/audio state
    // in the closure. The harness will then call place() with the components
    // and again on every change. teardown() runs before the next load.

    return {
        place(items, components) {
            // items:      array of card DOM elements (already wired with
            //             surface, mount lifecycle, callbacks).
            // components: parallel array of metadata for each card —
            //             { componentPath, scope, html, resources, ... }.
            //
            // The harness clears items' inline styles before each call, so
            // every place() starts from clean cards.
        },
        teardown() {
            // Remove DOM, listeners, timers. The next canvas.js load gets
            // a fresh root.
        }
    };
};
```

### State

State is canvas.js's own concern — the harness doesn't read or watch it.
If your canvas wants persistent state (camera position, per-card layout,
pin status), pick where to store it, fetch it yourself, and observe it
yourself.

The convention is JSON files in the canvas, e.g.:

- `<canvas>/state.json` for canvas-wide state.
- `<canvas>/components/<comp>/state.json` for per-component state.

Write via POST to `/workspace/writes`:

```js
fetch('/workspace/writes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
        writes: [
            { path: '<canvas-name>/state.json', content: { camera: { x, y, z, yaw, pitch } } }
        ]
    })
});
```

`path` is workspace-relative. `content` is any JSON-encodable value; the server writes it as pretty JSON. You can batch multiple writes in one call — the watcher pauses for the whole batch and emits one refresh.

Read by fetching the file URL (`fetch('/<canvas>/state.json')`) — either on mount, on a timer, or by listening to the harness's SSE update stream and refetching when something changed. The harness emits update events but does not parse state for you.

Debounce continuous inputs (camera scrolls, drags). The file is replaced verbatim — always send the full object you want stored.

### Hot reload

- Edit `canvas.js` → harness re-imports the module, calls `teardown()` on the prior instance, runs the factory again, places fresh.
- Edit a component (view.json, etc.) → harness re-runs `place()` with the new components. State is not re-passed; if you need it, fetch it.

### Editing canvas.js for anything non-trivial: use a sandbox

A one-line tweak in place is fine; the user sees one hot-reload and you move on. For anything bigger — rewriting `place()`, restructuring how state is consumed, multi-file changes that touch components and canvas.js together — work in a sandbox via `../testing/SKILL.md`, then apply atomically.

The flow:

1. Boot a sandbox of the workspace (`boot-workspace-sandbox.mjs`).
2. Make all your edits in the sandbox copy. Verify with Playwright or by interacting via the sandbox URL.
3. When ready, POST to the **source** server (not the sandbox), using the same `/workspace/writes` endpoint the browser uses — with `from` entries instead of `content`:

   ```sh
   curl -X POST http://127.0.0.1:<source-port>/workspace/writes \
       -H 'content-type: application/json' \
       -d '{
         "sandbox": "/var/folders/.../sandbox-workspace/Workspace.liquidos",
         "writes": [
           { "path": "gadgets/canvas.js", "from": "gadgets/canvas.js" },
           { "path": "gadgets/components/foo/state.json", "from": "gadgets/components/foo/state.json" }
         ]
       }'
   ```

   The source server pauses its watcher, processes all writes, then emits one refresh event. The user sees one transition, not one per file.

4. Terminate the sandbox launcher.

Each write entry is `{ path, content }` (inline JSON) or `{ path, from }` (copy from disk; relative paths resolve against `sandbox` if provided). Paths are workspace-relative; absolute paths and `..` traversal are rejected.

### Loading state

When you create or update a component instance, the first visible response should be a loading-state version of the relevant component. Keep it in place while work continues.

### Default

The scaffolder ships a CSS stack canvas.js that delegates to `/lib/css-layout.js`. Edit it freely or rewrite. Keep the default-export factory shape and the `{ place, teardown }` return shape; nothing else is fixed.

### What canvas.js does NOT own

The harness owns prompt bar, debug rail, loading/error chrome, the requirements editor. Don't style those from canvas.js. The components own their own surface content. canvas.js sits between: it decides where the components live and how the user navigates them.
