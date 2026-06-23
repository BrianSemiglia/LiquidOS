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

This is the **same `surface.__io` protocol components use** — `root` is the canvas's own surface, and the harness registers it in the relationship peer map under the reserved name **`canvas`** (so don't name a component folder `canvas`). A relationship wires a component to it like any other peer: `peers['rain-control'].on('intensity', v => peers['canvas'].send('rain-intensity', v))`. See the Relationships Skill.

Conforming to the protocol means declaring your **complete** interface once — every channel you accept via `send` and every channel you emit via `on`, with their meanings — and then leaving it alone. Declare the emit hooks even when nothing is wired to them yet; don't leave `on` a no-op stub to be fleshed out later when a wire finally needs it. An endpoint never names a peer or relationship, never branches on where a value came from, and never changes because a wire was added or removed — the relationship is the only piece that knows both ends and maps one onto the other. This is exactly how a component behaves; the canvas is not a special case, only a peer that lives on `root` instead of a card.

The endpoint is re-registered every time `canvas.js` re-mounts, so relationships bound to it re-wire automatically across canvas swaps. It is pure wiring: the relationship forwards events and nothing else. If the canvas wants the last value to survive a reload, it caches it itself (a state file it owns) — persistence is never the relationship's job.

### Stay inside root

Everything `canvas.js` paints — scene structure, scroll containers, full-viewport effects like rain, snow, scrims, or ambient particles — lives inside `root`. Attach overlay elements to `root`, position them relative to it, and use modest z-indices. The prompt bar, debug rail, and requirements editor sit on top via their own stacking context; if `canvas.js` reaches outside `root` (e.g. `document.body.appendChild`) or uses an out-of-context z-index (e.g. `9999`), its painting will cover them and break interactivity.

The harness owns the **canvas frame** (the `.canvas-shell` element `root` lives in): it positions, scrolls, and — when the user steps "out" of the canvas — insets it into a card. The frame is the containing block for *everything* you render, **including `position: fixed`**. So a fixed backdrop/scrim/rain layer is scoped to the frame and steps back *with* it — it does **not** anchor to the browser window. Use `position: fixed` for "cover the whole canvas and stay put while content scrolls" (backdrops, scrims), `position: absolute` for things pinned within your scrolling content, and normal flow for the rest. Never reach for the viewport (`100vw`/`100vh` anchored to the window, or escaping `root`) to cover the canvas — size to the frame and the harness keeps it correct in every state.

**System chrome always sits above content, and survives whatever you do to a card.** The harness reserves the top of the z-order for its own chrome — the prompt bar and canvas buttons (above the whole frame), and each component's **Requirements** button (above that component's card). Your canvas content, including any per-card buttons or controls you add, must use **modest z-indices** so it never paints over that chrome. The frame's containment keeps your z-indices scoped to the canvas, so "modest" just means low — don't try to out-stack the harness.

The per-component Requirements button lives in the component's own frame, so it lands in the right place and rides any transform you apply to the card (a 3D scene rotates it along with everything else). But if you *hide* the card — fold it to a pill with `opacity: 0` / `max-height: 0` on an ancestor, say — the harness detects that and **lifts** the button out into its own body-level overlay, pinned over the card's nearest still-visible box, then lowers it back when the card returns. (z-index can't rescue a descendant from an ancestor's `opacity`/`overflow: hidden`; moving it out of that subtree can.) So the button is resilient to whatever you do to a card without being flattened out of your coordinate space. You never host, position, or make room for system chrome — just build your card. If your card has its own top-right controls, they share that corner with the Requirements button (which stays on top); put yours elsewhere if you want them clear of it.

### Hot reload

- Edit `canvas.js` → `teardown()` runs on the prior instance, factory runs again, `place()` is called fresh.
- Edit a component → harness re-runs `place()` with updated metadata. Identity persists across the update; preserve position if you've assigned one.

### Non-trivial edits

Multi-file refactors, or anything that touches `canvas.js` and a component together, should go through a sandbox (see Testing Skill) and apply atomically. Single-line tweaks to `canvas.js` are fine in place — hot-reload makes them observable.

## Create a new canvas

```bash
bash skills/canvas/scripts/create-instance.sh <canvas> /path/to/Workspace.liquidos
```

Lays down the file layout above and registers the canvas in the workspace. The shipped `canvas.js` delegates to `/lib/css-layout.js` (CSS stack); edit it or rewrite — the only fixed shape is the default-export factory and the `{ place, teardown }` return.

## Delete a canvas

```bash
bash skills/canvas/scripts/delete-instance.sh <canvas> /path/to/Workspace.liquidos
```

Removes the canvas folder and commits the deletion to the workspace git timeline. This is a thin wrapper over the app's `canvas/delete-canvas.js` — the same module the in-app DELETE endpoint (the picker's ✕ button) calls — so deleting from the agent and deleting from the UI behave identically.
