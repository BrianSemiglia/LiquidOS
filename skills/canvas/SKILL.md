---
name: canvas
description: Canvas-scope work — how components are arranged on screen, how the user navigates them, and how they behave as a group
triggers:
  - User wants to create a new canvas
  - User wants to change how components are arranged or presented (stack, grid, 3D, etc.)
  - User wants components to behave as a group (scroll-linked animation, snap, swipe-to-dismiss)
  - User wants canvas-level input (custom scroll, keyboard shortcuts, gestures)
---

# Canvas

A canvas is one screen-worth of components and the rules for how they live together — where they sit, how the user moves between them, how they respond as a group. Components themselves are black boxes: the canvas knows each one by name and assigns its bounds, but doesn't reach into its content.

Land here when the work is about *how components are presented and navigated*, not what any one component is or does. Component-internal work belongs in Component Skill.

## Files

```text
<canvas-name>/
  input.json                  — manifest: { "components": [<canvas-relative path>, ...] }
  canvas.js                   — presentation, input, group behavior
  feature-requirements.txt    — plain-text intent: what this canvas is for
  components/                 — component folders (see Component Skill)
  relationships/              — wires between components (see Relationship Skill)
```

Add or remove components by editing `input.json`. Change arrangement, navigation, or group behavior by editing `canvas.js`. Update intent in `feature-requirements.txt`.

## feature-requirements.txt

Plain-text, user-facing description of what this canvas is for — what it should let the user do, how it should feel. Read it first when working on a canvas; update it when intent changes. Keep implementation details out — `canvas.js` is for those.

### Relationships

Describes wires between components in prose. The agent reconciles the `relationships/` folder to match. See Relationships Skill.

### Example

```text
A diorama of small tools and ambient widgets. Components float in 3D
space and gently bob; the user pans by dragging and zooms by scrolling.
Each one is a tactile object — small, soft lighting, no chrome.

## Relationships

- Pressing keys on the rainbow-keyboard sets the color-picker's color;
  multiple keys mix into one color.
- The clock's hourly tick scrolls the timeline to "now".
```

## canvas.js

Every canvas has exactly one `canvas.js` at its root.

### Contract

```js
export default (root, context) => {
    // Build chrome, attach input listeners, hold any state in this closure.
    // `root` is the canvas DOM region you own; `context` includes canvasPath.

    return {
        place(items, components) {
            // Called on every change. items[i] is the already-mounted DOM
            // element for components[i] — position it, that's all.
        },
        teardown() {
            // Cleanup before the next factory call (or canvas swap).
        }
    };
};
```

### What canvas.js sees

Each `place()` call hands you:

- `items` — the mounted DOM elements, one per component, ready to position.
- `components` — parallel metadata. The canvas-scope fields are **identity** (each component's name/path, so you can recognize the same one across updates and preserve animation phase or position) and the bounds you assign.

Components are black boxes. The canvas may wrap them with behaviors and presentations — scroll-linked animation, snap, swipe-to-dismiss, anything that surrounds rather than enters them — but their content belong to the component itself.

The harness clears each item's inline styles before every `place()` call, so each call starts clean.

### Stay inside root

Everything `canvas.js` paints — scene chrome, scroll containers, full-viewport effects like rain, snow, scrims, or ambient particles — lives inside `root`. Attach overlay elements to `root`, position them relative to it, and use modest z-indices. The harness chrome (prompt bar, debug rail, requirements editor) sits on top via its own stacking context; if `canvas.js` reaches outside `root` (e.g. `document.body.appendChild`) or uses an out-of-context z-index (e.g. `9999`), its painting will cover that chrome and break interactivity.

### Hot reload

- Edit `canvas.js` → `teardown()` runs on the prior instance, factory runs again, `place()` is called fresh.
- Edit a component → harness re-runs `place()` with updated metadata. Identity persists across the update; preserve position if you've assigned one.

### Non-trivial edits

Multi-file refactors, or anything that touches `canvas.js` and a component together, should go through a sandbox (see Testing Skill) and apply atomically. Single-line tweaks to `canvas.js` are fine in place — hot-reload makes them observable.

## Create a new canvas

```bash
bash skills/canvas/scripts/create-instance.sh <canvas-name> /path/to/Workspace.liquidos
```

Lays down the file layout above and registers the canvas in the workspace. The shipped `canvas.js` delegates to `/lib/css-layout.js` (CSS stack); edit it or rewrite — the only fixed shape is the default-export factory and the `{ place, teardown }` return.
