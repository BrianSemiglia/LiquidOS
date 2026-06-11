---
name: component
description: Create and modify LiquidOS canvas components
triggers:
  - User asks to create a component
  - User asks to update a component
  - User asks to build visible UI
---

# Component

A component is a folder under a canvas. The contract:

- `component.html` — the entry. The canvas paints it.
- `feature-requirements.txt` — plain-text description, one item per line, for the user.

Everything else (data files, services, scripts, native binaries) is the agent's choice.

## What lives in `component.html`

`component.html` is the component's initial body. The harness loads it on first paint and re-renders it on every subsequent file change — one rule, no modes. Two things about the re-render are worth knowing:

- **`<liquidos-file>` mounts have identity.** A mount that stays put across an edit (same `path`, same attributes) keeps its running service and hydrated children. A mount whose `path` or attributes changed is replaced wholesale — the old service tears down, the new one starts. New mounts are added; missing mounts are removed.
- **Everything else is diffed position-by-position** against the live DOM — attributes synced, children recursed, mismatches replaced. Standard structural reconcile.

Runtime DOM state (typed inputs, focus, scroll, in-flight pulses) is **not auto-preserved** across re-renders. If the user produces state, the agent is responsible for persisting it to a workspace file and reading it back on render — the disk is the source of truth, not the live DOM.

The body of `<liquidos-component>` IS your component's DOM. Inline `<style>`, real elements, real controls — that's the whole component for anything self-contained:

```html
<liquidos-component path="components/clock">
    <style>
        .clock { font-size: 4rem; font-variant-numeric: tabular-nums; }
    </style>
    <div class="clock" id="clock-time">--:--</div>
    <liquidos-file path="components/clock/functions.js" script></liquidos-file>
</liquidos-component>
```

Three custom elements are available inside the body:

- **`<liquidos-callback>`** wraps any control. The control's declared event (`on="click"`, `on="submit"`, …) dispatches a prompt to the agent. The harness disables and pulses the control while the request is in flight.
- **`<liquidos-file path="…" script>`** dynamic-imports the file as an ES module and calls `mount(surface)`. Use this for browser-side state, listeners, audio contexts, anything the DOM alone doesn't cover.
- **`<liquidos-file path="…" run>`** asks the harness to spawn the file as a long-running process. Use this when the component genuinely needs a backend — watching files, holding a socket, calling native APIs.

The default `<liquidos-file path="…"></liquidos-file>` (no attributes) fetches the file and renders its content. Pair it with a `run` process when something is producing painted output from outside the agent's stream.

## Building the body progressively

The user watches the canvas while you work, and what they see should always be honest: a control that isn't ready yet should not look ready. Build the body in visible steps:

1. **Scaffold.** `bash skills/component/scripts/create-component.sh <canvas-path> <name>`. Writes:
   - `diagnostics/status.json` seeded with `{}`
   - `component.html` containing an empty `<liquidos-component>` wrapper
   - `feature-requirements.txt` with one seed line
   - the component path appended to the canvas's `input.json`, last, so the canvas never sees a reference to a missing file

   Prints one-line JSON naming the sanitized component and its absolute path.
2. **Shell.** One `<lqpatch op="streamFile" target="<canvas>/components/<name>/component.html">…</lqpatch>` writes the `<style>` block and the outer containers — empty regions with stable IDs on every part you might later want to target by selector. Without them, the only way to change anything is to rewrite the whole file.
3. **Fill.** Land the rest of the body in visible chunks — one `<lqpatch>` per piece. `op="append"` for a list of items, `op="replace"` for shaped regions. Avoid a single giant write; the user should see it grow, not pop in already finished.
4. **Wiring.** If the component needs `functions.js`, that's a separate `streamFile` after the visible elements are in place.

Selectors in `op="append"` / `op="replace"` markers are matched with `document.querySelector` against the live page. Use IDs you wrote into the shell — class and attribute selectors also work.

Read `<canvas>/feature-requirements.txt` first if it exists — your component should fit the canvas's intent. Work on one component per turn.

## `functions.js`

A script-mode `<liquidos-file>` imports the file as an ES module and calls:

```js
export const mount = (surface) => {
    // Wire listeners and create resources. Scope queries with surface.querySelector.
    return () => { /* tear down */ };
};
```

- **`mount()` may run more than once.** Anything content depends on can change (re-stream, edits to `functions.js`) and re-mount. Setup must be idempotent — if you allocate an audio context here, release it in the cleanup return.
- **The return value cleans up the previous instance.** A plain function, or an object with `.destroy()`. Without a return, listeners and timers accumulate across re-mounts.
- **HTML emitted into the DOM must be deterministic.** Same inputs, same output. No `Math.random()` in IDs, classes, or gradients. Otherwise the harness sees every re-render as new content and re-runs setup unnecessarily.

All browser-side JS goes through script-mode `<liquidos-file>`. Inline `<script>` tags don't execute when injected via `innerHTML`; inline event handlers (`onclick=`, etc.) bypass the `mount(surface)` lifecycle and leak listeners on every re-mount.

Use `<liquidos-callback>` for user-initiated callbacks routed through the agent. Use `mount(surface)` for everything else.

### Subscribing to workspace events

`functions.js` can subscribe to workspace file changes:

```js
export const mount = (surface) => {
    const off = window.liquidos.onWorkspaceEvent(payload => {
        if (payload?.type !== 'workspace-file') return;
        if (payload.path === 'components/<name>/data/some-state.json') {
            // re-fetch, update DOM
        }
    });
    return () => off();
};
```

The harness pushes every change in the workspace. Filter by path.

## Components with a backend process

When the component needs a long-running process (a feed reader, a native bridge, a file watcher), wire it inline:

```html
<liquidos-component path="components/feed">
    <liquidos-file path="components/feed/services/foo.sh" run></liquidos-file>
    <liquidos-file path="components/feed/foo.html"></liquidos-file>
</liquidos-component>
```

The `run` element spawns the file at its `path` as a process; the default `<liquidos-file>` renders `foo.html` and re-renders whenever the process rewrites it. Conventional layout:

- service scripts in `components/<name>/services/`
- internal state in `components/<name>/data/`
- stdout/stderr in `components/<name>/diagnostics/service.log`

Reach for this shape only when something genuinely external is producing the content — a process that watches files, holds a socket, talks to native APIs. Self-contained interactive components don't need it; their DOM goes inline.

## Feature requirements

`feature-requirements.txt` is user-facing.

- Plain text. No title, no markdown headings.
- Each line is one requirement, written in plain language.
- Requirements must be faithful to the component — no claims about behavior, resources, or limits the component does not actually provide.
- When requirements and implementation disagree, resolve the mismatch instead of preserving inaccurate text.

## Updating an existing component

The component is already on the page. The user is watching its current state, and they expect the changes to *land on* it — not for it to disappear and a new one to take its place. Your edits target the live DOM through specific selectors.

1. Read `<canvas>/components/<name>/feature-requirements.txt` to confirm the component's purpose, and `<canvas>/feature-requirements.txt` for the canvas's intent. If the user is reporting a problem, also check `diagnostics/`. For "feels slow / hot / stuck", run `processes` — it lists every component's CPU and memory.
2. Find the smallest set of elements that need to change, and emit one `<lqpatch>` marker per change, targeting a selector already in the rendered DOM:
   - `op="replace" target="#some-id"` — swap an inner region's contents.
   - `op="setAttr" target="#some-id" attr="style" value="…"` — retune a single attribute.
   - `op="append" target="#some-id"` — add an item.
   - `op="prepend" target="#some-id"` — add an item at the start.
   - `op="remove" target="#some-id"` — drop one.
   The user sees each one land as a discrete beat, the same way they saw the original elements arrive.
3. For a style overhaul (a vibe shift, a theme change), `op="replace"` on the existing `<style>` element's contents is one marker that swaps the look in place. The DOM keeps its shape; only the painted appearance changes.
4. For behavior changes, update `functions.js` with `op="streamFile"`. The harness re-mounts; your old cleanup runs.
5. Update `feature-requirements.txt` if anything was learned.

`streamFile` on `component.html` is the right move when the skeleton itself is changing — different containers, different IDs, different mounts, different wiring. Otherwise edit the live DOM via `<lqpatch>` selectors. Running services and hydrated views survive across the re-render as long as their `<liquidos-file>` is unchanged; static markup rebuilds.

## Progressive view updates

While the agent is mutating a component, intermediate writes must set `disabled` on any inputs that would mutate the same data. Disabled inputs don't fire events; otherwise concurrent user input races the in-progress mutation and silently loses edits.

Inputs wrapped in `<liquidos-callback>` are auto-disabled by the harness while their callback's request is in flight, so they don't need manual `disabled` for that case. The rule covers plain HTML inputs whose value the agent rewrites programmatically.

Before each rewrite, narrate the intent: which inputs are being disabled or restored, and why.

### Example

Prompt: "fix the spelling". Component: `components/note/`.

Starting markup (interactive):

```html
<textarea name="text">i wnat to byu groceries tommorow</textarea>
```

**Placeholder write.**

> *Narration:* "I'm about to mutate `components/note/component.html`. I need to disable the textarea so the user can't type a competing edit before I finish."

```html
<p>Checking spelling…</p>
<textarea name="text" disabled>i wnat to byu groceries tommorow</textarea>
```

**Final write** — `<p>` removed, corrected text in place, `disabled` dropped:

```html
<textarea name="text">I want to buy groceries tomorrow.</textarea>
```

## Removing

1. Remove the component path from `<canvas>/input.json`.
2. Delete the folder at `<canvas>/components/<name>/` (skip this if the user asked to hide).

## Offer actions, don't just display state

LiquidOS components are rendered by an agent that can act for the user — fetch data, repair errors, regenerate content, change scope, follow up. Whenever a view shows something the user might want to act on, include a `<liquidos-callback>` that does the action. The affordance is why the user is here.

Default to "offer the action":

- An error: include a fix button.
- An empty state ("No items yet"): include a way to add one.
- A data display that might want refresh / filter / sort: include controls.
- A configuration that might want to change: make it editable.

Instead of:

```html
<p>Could not load weather data.</p>
```

do:

```html
<p>Could not load weather data.</p>
<liquidos-callback on="click" scope="components/weather"
    prompt="Retry loading the weather data; the previous load failed.">
    <button>Retry</button>
</liquidos-callback>
```

Exception: when you've isolated the failure to a harness or infrastructure problem you can't fix from inside the component (see Escalation), say so and stop. A button that loops back to the same failure is worse than no button.

## Declare what you need; work in less

Two responsibilities:

- **Declare what the component needs**, no more. The outermost element carries a `min-width` (and where useful a `width` / preferred size) that reflects the *actual* content minimum — the width below which the component genuinely stops working. The presentation reads this signal to decide layout. Over-declaring wastes space; under-declaring lets the presentation crush you.
- **Still work when given less.** Degrade gracefully: `max-width: 100%`, `min-width: 0` on flex children that can compress, `overflow-x: auto` for intrinsically-wide content (tables, code, image strips).

## Catch only when you can recover

`<liquidos-component>` watches its own `diagnostics/status.json`. The harness's error router attributes thrown errors to the component whose script-mode `<liquidos-file>` is on the stack, writes them under `runtime` in `status.json`, and the chrome surfaces a Repair button.

This means: don't catch errors you cannot recover from. A `try/catch` that ends in `setStatus("Bad state: " + error.message, false)` — or any "rebrand the failure as a red message" — hides the problem from both the agent and the harness. The component looks broken to the user, but to the listener it looks fine, so no Repair is offered.

Catch when you have an actual recovery move:

- **Transient connection states.** `source.onerror = () => setStatus("Reconnecting…")` — SSE auto-reconnects; this is UI state, not an error.
- **Real fallback.** `fetch(url).catch(() => useCache())` where there's a cache to fall back to.
- **Input validation.** "Please enter a number" on bad user input — the failure isn't a bug.

Let the rest throw. A failed `JSON.parse`, an unexpected schema, "tried to call .map on undefined" — the component has no plan for these, so the Repair button *is* the plan.

## Diagnostics

When something looks broken, look in `<component>/diagnostics/` first. Status is in `status.json`; service stdout/stderr is in `service.log`.

### Escalation

If you've isolated the problem to the harness or infrastructure and there's no fix from inside the component, communicate with the user through the canvas — write the escalation into `component.html` so it appears as the component's view.

A useful escalation view names:
- What was reported broken.
- What you confirmed works.
- What you suspect is wrong.
- That you are stopping rather than working around it.

Then stop. The user reads the canvas, fixes the harness, and may ask you to retry.

## Prompt callbacks (reference)

`<liquidos-callback>` wraps controls whose events should call the agent:

```html
<liquidos-callback
    on="submit"
    scope="components/chat"
    values="message"
    prompt="User wants to send this message: {{message}}">
    <form>
        <input name="message" placeholder="Message" />
        <button type="submit">Send</button>
    </form>
</liquidos-callback>
```

- `on` — the DOM event (`submit`, `click`, `change`, …).
- `prompt` — the prompt template. `{{field}}` substitutions are read from form fields.
- `prompt-from` — alternative to `prompt`; uses the entire current value of the named field.
- `values` — required when `prompt` uses placeholders. Comma-separated allowlist of field names.
- `scope` — canvas-relative path of the thing calling back (`components/chat`).

## Files outside the workspace

The harness serves workspace paths your `<liquidos-file>` elements reference:

```html
<liquidos-file path="components/random-image/photo.jpg"></liquidos-file>
```

For files outside the workspace, serve them via a local HTTP server in your component's service:

```bash
cd ~/Pictures
python3 -m http.server 8000
```

Then reference via HTTP URL:

```html
<img src="http://localhost:8000/example.png" style="max-width:100%">
```

The harness doesn't proxy arbitrary `file://` paths or absolute filesystem paths.
