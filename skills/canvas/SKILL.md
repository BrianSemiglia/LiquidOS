---
name: canvas
description: Canvas-scope work — how components are arranged on screen, how the user navigates them, and how they behave as a group
triggers:
  - User wants to create a new canvas
  - User wants to change how components are arranged or presented (stack, grid, 3D, etc.)
  - User wants components to behave as a group (scroll-linked animation, snap, swipe-to-dismiss)
  - User wants canvas-level input (custom scroll, keyboard shortcuts, gestures)
  - Canvas-level Repair: index.json, canvas.js, or anything else flagged as a damaged canvas
---

# Canvas

A canvas is one screen-worth of components and the rules for how they live together — where they sit, how the user moves between them, how they respond as a group. Components themselves are black boxes: the canvas knows each one by name and assigns its bounds, but doesn't reach into its content.

The harness frames each component in its own **card** — the bounded region it paints into, with its Requirements button pinned above. The canvas arranges the cards; the component owns what's inside one. "Card" means this per-component frame throughout.

Land here when the work is about *how components are presented and navigated*, not what any one component is or does. Component-internal work belongs in Component Skill.

## Files

```text
<canvas>/
  index.json                  — manifest: { "components": ["components/<name>/component.html", ...] }
  canvas.js                   — presentation, input, group behavior
  feature-requirements.txt    — plain-text intent: what this canvas is for
  components/                 — component folders (see Component Skill)
  relationships/              — wires between components (see Relationship Skill)
```

Each entry in `index.json`'s `components` array is a canvas-relative path to a component's `component.html` entry file. Folder-only paths (`"components/<name>"`) won't render — the harness flags the canvas as damaged and surfaces a Repair affordance.

Add or remove components by editing `index.json`. Change arrangement, navigation, or group behavior by editing `canvas.js`. Update intent in `feature-requirements.txt`.

## feature-requirements.txt

Plain-text, user-facing description of what this canvas is for — what it should let the user do, how it should feel. Read it first when working on a canvas; update it when intent changes. Keep implementation details out — `canvas.js` is for those. Write the requirements as bullets, each line beginning with `- `.

### Relationships

Describes wires between components in prose. The agent reconciles the `relationships/` folder to match. See Relationships Skill.

### Example

```text
- A diorama of small tools and ambient widgets.
- Components float in 3D space and gently bob.
- The user pans by dragging and zooms by scrolling.
- Each one is a tactile object — small, soft lighting, no chrome.

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
    // Build scene structure, attach input listeners, hold any state in this closure.
    // `root` is the canvas DOM region you own; `context` includes canvasPath.

    return {
        place(items, components) {
            // Optional. Called on every change. items[i] is the already-mounted
            // DOM element for components[i] — position it, that's all.
        },
        teardown() {
            // Cleanup before the next factory call (or canvas swap).
        }
    };
};
```

### Splitting canvas.js into modules

Split `canvas.js` into as many files as you want. Import them with ordinary
`import`/`export` and static relative paths — `import { MANSION } from
'./forest/env.js'`. Every module imported this way hot-reloads like `canvas.js`.

- Don't add `?v=` or any cache-busting to import paths.
- Don't import a module by a computed path (`import('./' + name)`) if you want it
  to hot-reload — use a literal path.

### Streamable regions

A canvas can host authored content the agent streams into — not just component
cards. Place a render-mode file marked `stream-surface`:
`<liquidos-file path="regions/hero.html" stream-surface>`. It renders that file,
re-renders when it changes, and — because of the `stream-surface` attribute — the
agent's stream persists into that file. Put several addressable elements (ids) in
one file if you want multiple targets. A prompt scoped to the file's path streams
into it, exactly like a component streams into its `component.html`.

### What canvas.js sees

Each `place()` call hands you:

- `items` — the mounted DOM elements, one per component, ready to position.
- `components` — parallel metadata. The canvas-scope fields are **identity** (each component's name/path, so you can recognize the same one across updates and preserve animation phase or position) and the bounds you assign.

Components are black boxes. The canvas may wrap them with behaviors and presentations — scroll-linked animation, snap, swipe-to-dismiss, anything that surrounds rather than enters them — but their content belong to the component itself.

The harness clears each item's inline styles before every `place()` call, so each call starts clean.

### Canvas as an I/O peer

Some canvas behavior has no card of its own — the camera, the ambient environment, a full-viewport rain or snow effect. It lives in `canvas.js`, not in any component, so a component can't reach it through a normal component-to-component relationship. To let one, attach an I/O endpoint to `root`:

```js
export default (root, context) => {
    let intensity = 0;
    const listeners = new Set();
    const setRain = (v) => { intensity = v; /* apply live */ listeners.forEach(fn => fn(v)); };
    root.__io = {
        // Accepts: channels this canvas consumes, and what each does.
        send(channel, payload) {
            if (channel === 'rain-intensity') setRain(payload); // 0..1, applies live
        },
        // Emits: channels this canvas publishes. Declare them whether or not
        // anything is wired to them yet — a relationship subscribes via on().
        on(channel, fn) {
            if (channel !== 'rain-intensity') return () => {};
            listeners.add(fn);
            fn(intensity);                 // replay current value to a new subscriber
            return () => listeners.delete(fn);
        },
    };
    return { place(items, components) { /* … */ }, teardown() { /* … */ } };
};
```

This is the **same `surface.__io` protocol components use** — `root` is the canvas's own surface, available to relationships under the reserved name **`canvas`** (so don't name a component folder `canvas`). A relationship wires a component to it like any other peer: `peers['rain-control'].on('intensity', v => peers['canvas'].send('rain-intensity', v))`. See the Relationships Skill.

The canvas follows the same endpoint contract as every other peer — declare your complete interface once, declare emit hooks even before anything is wired, never name a peer, never branch on where a value came from. That contract is stated once in [Relationships → The I/O contract](../relationships/SKILL.md#the-io-contract); it applies here unchanged. The canvas is not a special case, only a peer that lives on `root` instead of a card.

The one canvas-specific detail: relationships bound to the canvas re-wire automatically across canvas swaps. If the canvas wants a value to survive a reload, it caches it itself (a state file it owns) — persistence is never the relationship's job.

### Stay inside root

Everything `canvas.js` paints — scene structure, scroll containers, full-viewport effects like rain, snow, scrims, or ambient particles — lives inside `root`. Attach overlay elements to `root`, position them relative to it, and use modest z-indices. The prompt bar, debug rail, and requirements editor sit on top via their own stacking context; if `canvas.js` reaches outside `root` (e.g. `document.body.appendChild`) or uses an out-of-context z-index (e.g. `9999`), its painting will cover them and break interactivity.

The harness owns the **canvas frame** that `root` lives in: it positions, scrolls, and — when the user steps "out" of the canvas — insets the whole frame into a thumbnail. The frame is the containing block for *everything* you render, **including `position: fixed`**. So a fixed backdrop/scrim/rain layer is scoped to the frame and steps back *with* it — it does **not** anchor to the browser window. Use `position: fixed` for "cover the whole canvas and stay put while content scrolls" (backdrops, scrims), `position: absolute` for things pinned within your scrolling content, and normal flow for the rest. Never reach for the viewport (`100vw`/`100vh` anchored to the window, or escaping `root`) to cover the canvas — size to the frame and the harness keeps it correct in every state.

**System chrome always sits above content, and survives whatever you do to a card.** The harness reserves the top of the z-order for its own chrome — the prompt bar and canvas buttons (above the whole frame), and each component's **Requirements** button (above that component's card). Your canvas content, including any per-card buttons or controls you add, must use **modest z-indices** so it never paints over that chrome. The frame's containment keeps your z-indices scoped to the canvas, so "modest" just means low — don't try to out-stack the harness.

The per-component Requirements button belongs to the harness, not your card. It rides any transform you apply (a 3D scene rotates it along) and survives clipping the card away (folding to a pill, `display: none` on an ancestor) — you never host, position, or make room for it, just build your card. If your card has its own top-right controls, put them elsewhere: that corner is the Requirements button's, and it stays on top.

### Hot reload

- Edit `canvas.js` — or any module it imports (see *Splitting canvas.js into modules*) → `teardown()` runs on the prior instance, the factory runs again, `place()` is called fresh.
- Edit a component → harness re-runs `place()` with updated metadata. Identity persists across the update; preserve position if you've assigned one.

### Non-trivial edits

Multi-file refactors, or anything that touches `canvas.js` and a component together, should go through a sandbox (see Testing Skill) and apply atomically. Single-line tweaks to `canvas.js` are fine in place — hot-reload makes them observable.

## Create a new canvas

```bash
bash skills/canvas/scripts/create-instance.sh <canvas> /path/to/Workspace.liquidos
```

Lays down the file layout above and registers the canvas in the workspace. The shipped `canvas.js` delegates to `/lib/css-layout.js` (CSS stack); edit it or rewrite — the only fixed shape is the default-export factory returning an object. `place(items, components)` and `teardown()` are both optional; the shipped default implements only `teardown` and lets CSS handle layout.

## Delete a canvas

```bash
bash skills/canvas/scripts/delete-instance.sh <canvas> /path/to/Workspace.liquidos
```

Removes the canvas folder and commits the deletion to the workspace git timeline. Deleting from the agent and deleting from the UI's picker behave identically.
