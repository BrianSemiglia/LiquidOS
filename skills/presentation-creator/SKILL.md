---
name: presentation-creator
description: Create or modify LiquidOS canvas presentations — the JS modules that decide how a canvas's components are arranged and viewed
triggers:
  - User asks to create a new presentation
  - User asks to change how a canvas is rendered
  - User wants a custom layout, scene, room, grid, or other view of a canvas
  - User mentions presentations
---

# Presentation Creator

A presentation decides how a canvas's components are arranged on screen. The harness creates each component card (surface, mount wiring, requirements editor); the presentation places those cards however it likes — a flat CSS layout, a 3D room, an infinite zoomable canvas, a node graph, whatever.

A canvas has exactly one active presentation, named in its `input.json`:

```json
{ "presentation": "presentations/room-3d.js" }
```

## Files

```
<canvas>/presentations/<name>.js                     ← the presentation module
<canvas>/state.<name>.json                           ← optional, canvas-wide state
<canvas>/components/<comp>/state.<name>.json         ← optional, per-component state
```

`<name>` is the basename of the presentation file without `.js`. So `presentations/room-3d.js` has state files `state.room-3d.json`.

## The contract

A presentation is an ES module whose default export is a factory:

```js
export default (root, context) => {
    // root: the canvas DOM region the presentation owns.
    // context: { canvasPath } — useful for state keys, logging, etc.
    //
    // Set up your scene chrome (style, world container, camera, listeners).
    // The harness will then call place() with the components, and place()
    // again on every change. teardown() runs when the presentation is being
    // replaced.

    return {
        place(items, components, state) {
            // items:      array of card DOM elements (already have .surface,
            //             .component-back, wired callbacks, mount lifecycle).
            // components: parallel array of metadata for each card —
            //             { componentPath, scope, html, resources, ... }.
            // state:      { canvas, components: { scope: ... } } — current
            //             state read from the workspace files.
            //
            // Position the items, read whatever state is relevant, update
            // the scene. The harness clears items' inline styles before
            // each call, so you start from clean cards.
        },
        teardown() {
            // Remove DOM, listeners, timers. The next presentation will
            // get a fresh root.
        }
    };
};
```

Everything else — file watching, mount(surface) for browser-side JS in components, the prompt bar, the debug rail — stays the harness's job.

## CSS-only presentations

If your presentation is "apply this CSS and let the cards lay out themselves," use the shared helper. The whole presentation can be a few dozen lines:

```js
import { cssLayout } from '/lib/css-layout.js';

export default cssLayout(`
    #app { display: flex; flex-direction: column; gap: 1rem; }
    .item { border-radius: 10px; padding: 1rem; }
`);
```

`cssLayout(cssText)` returns a factory that applies the stylesheet to `<head>` and places cards as direct children of `root`. That's it. Pair with the canvas's own CSS variables and harness conventions (`--prompt-chrome-space`, `--debug-rail-space`) as needed.

## State

State is JSON, lazy-created, hot-reloaded. The presentation defines its own schema — the harness is dumb storage.

### Reading

State arrives as the third argument to `place()`:

```js
place(items, components, state) {
    // state.canvas — global state for this presentation, or null if no file.
    // state.components[scope] — per-component state, or null/undefined.
}
```

When a state file changes (because the user or agent edited it, or because you POSTed an update), `place()` is called again with the new state.

### Writing

POST to `/state` from the browser. The harness writes the file:

```js
fetch('/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
        scope: 'canvas',                       // or 'component'
        componentPath: '...',                  // required when scope='component'
        presentation: 'room-3d',               // base name, no extension
        data: { camera: { x, y, z, yaw, pitch } }
    })
});
```

Debounce continuous inputs (camera scrolls, drags). The file is replaced verbatim, so always send the full object you want stored.

### Layers

Use the canvas-level file for things that aren't owned by any single component — camera, zoom level, scroll offset. Use per-component files for arrangement state that belongs to a specific card — position, rotation, pinned status. Same shape conceptually; the split is about ownership.

### Missing files

Both layers are optional. `state.canvas` may be `null`. `state.components[scope]` may be `null` or absent. Presentations must handle this — fall back to sensible defaults (tile components, center the camera, etc.). The first user interaction creates the file via the POST endpoint.

## Hot reload

Two paths, both automatic:

- **Edit the presentation file** → harness sees the mtime change, ships a new `presentationVersion`, client re-imports the module, calls teardown + a fresh factory + place. Full reboot of the presentation. Lose any in-flight state held only in the closure.
- **Edit a state file** → harness re-aggregates, calls place again with new state. Presentation stays mounted; just receives the new data.

The user and the agent can both edit either kind of file directly. The presentation should react.

## Lifecycle

```
factory(root, context)   ← once per mount
  → returns { place, teardown }

place(items, components, state)   ← every render: components changed,
                                    state changed, or canvas first paint.

teardown()                ← once, when the presentation is being replaced.
```

A presentation closure persists across `place()` calls — that's the right place to hold camera state, animation timers, audio contexts, etc. Hot-reload of the presentation file blows the closure away (factory re-runs); hot-reload of a state file does not.

## Controls

The presentation can install global listeners (`window.addEventListener('keydown', ...)`) because at any time exactly one presentation is mounted. Two conventions to keep things friendly:

- **Skip when typing.** Check `document.activeElement` — if it's an `<input>`, `<textarea>`, or `contentEditable` element, let the keystroke through. The user is typing in a component.
- **`preventDefault` what you consume.** macOS plays an "invalid input" beep if a tracked key isn't `preventDefault`'d. Always preventDefault the keys you actually use.

## Handing focus to a component

When a component should consume keys that the presentation normally captures (e.g., walking around the 3D room, then "stepping into" a piano keyboard so WASD plays notes instead of moving you), the presentation owns the toggle.

The convention is a marker class on the focused card's wrapper:

```js
// in presentation.place(), when a component is engaged:
cardWrap.classList.add('is-focused');
```

The presentation stops processing its own keys while any wrapper carries `.is-focused`. The component's `functions.js` checks for the marker before reacting:

```js
window.addEventListener('keydown', (e) => {
    if (!surface.closest('.is-focused')) return;
    // ...handle keys
});
```

Trigger the toggle however fits the presentation — click on a card, proximity, dedicated keypress, explicit menu. Esc usually disengages.

## Shipping a presentation

Drop the file in the canvas's `presentations/` folder, name it in `input.json`. The harness picks it up on the next render. If the presentation file is missing or its factory throws, the canvas shows a repair card; if `place()` throws, the harness drops the presentation and renders cards directly so the canvas isn't frozen.

The agent can deliver a new presentation in one move: write the JS file, update input.json's `presentation` field, done.

## Default presentations LiquidOS ships

- `presentations/stack.js` — vertical flex layout, the default for new canvases. Uses `cssLayout`. Edit the CSS to taste.
- `presentations/room-3d.js` — first-person 3D scene. WASD + trackpad scroll. Camera persists to `state.room-3d.json` at the canvas root. Per-component positions can be set via `state.components[scope].position = [x, y, z]` in each component's `state.room-3d.json`.

Copy or fork these as starting points.
