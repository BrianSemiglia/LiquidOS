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

A component is **self-contained and portable** — copy its folder to another canvas or workspace and it still works. Everything it needs lives inside the folder, including any state it persists.

## What lives in `component.html`

`component.html` is the component's initial body. The harness loads it on first paint and re-renders it on every subsequent file change — one rule, no modes. Two things about the re-render are worth knowing:

- **`<liquidos-file>` mounts have identity.** A mount that stays put across an edit (same `path`, same attributes) keeps its running service and hydrated children. A mount whose `path` or attributes changed is replaced wholesale — the old service tears down, the new one starts. New mounts are added; missing mounts are removed.
- **Everything else is diffed position-by-position** against the live DOM — attributes synced, children recursed, mismatches replaced. Standard structural reconcile.

Runtime DOM state (typed inputs, focus, scroll, in-flight pulses) is **not auto-preserved** across re-renders. Persist anything the user produces to a file inside the component and read it back on render — the disk is the source of truth, not the live DOM. Never `localStorage` or anything keyed to the browser; it doesn't travel with the component.

The body of `<liquidos-component>` IS your component's DOM. Inline `<style>`, real elements, real controls — that's the whole component for anything self-contained:

```html
<liquidos-component path="components/clock">
    <style>
        .clock { font-size: 4rem; font-variant-numeric: tabular-nums; }
    </style>
    <div class="clock" id="clock-time">--:--</div>
    <liquidos-file path="components/clock/clock.js" script></liquidos-file>
</liquidos-component>
```

Three custom elements are available inside the body:

- **`<liquidos-callback>`** wraps any control. The control's declared event (`on="click"`, `on="submit"`, …) dispatches a prompt to the agent. The harness disables and pulses the control while the request is in flight.
- **`<liquidos-file path="…" script>`** runs a script you provide as an ES module that exports `mount(surface)` — for browser-side state, listeners, anything the DOM alone doesn't cover. It re-runs whenever the component re-renders, so make setup idempotent and return a cleanup function. Keep emitted HTML deterministic (no `Math.random()` in IDs or classes) or every re-render looks like new content. Don't use inline `<script>` or `on*=` handlers — injected `<script>` never runs, and inline handlers leak on every re-render.
- **`<liquidos-file path="…" run>`** asks the harness to spawn the file as a long-running process. Use this when the component genuinely needs a backend — watching files, holding a socket, calling native APIs.

The default `<liquidos-file path="…"></liquidos-file>` (no attributes) fetches the file and renders its content. Pair it with a `run` process when something is producing painted output from outside the agent's stream.

## Building and changing the body

Create the component if it isn't on the canvas yet, then **stream its HTML elements in — one element per patch.** Never a block of markup with its children inline: a card is its frame appended first, then its image, heading, price, and button each appended into it. The user watches every element land.

- **Create** (only when it doesn't exist): `bash skills/component/scripts/create-component.sh <canvas-path> <name>`. That registers it and gives you an empty `<liquidos-component>` — the root you stream into.
- **Stream** element by element: `op="append"` / `"prepend"` one element to a selector **already in the live DOM** — the component root, or a parent you appended a moment ago. To nest, append the parent (empty) first, then append each child into it. `op="replace"` swaps an element (or the `<style>` for a theme), `op="setAttr"` retunes one, `op="remove"` drops one.

Two ways to skip the stream, both leaving the user staring at nothing: aiming a patch at a container you haven't put in the DOM yet (it has no target), or `writeFile`-ing the whole view into `component.html` (it lands all at once on disk, off-stream — and the generic Write tool does the same). Patches aimed inside the `<liquidos-component>` persist back to `component.html`, so what you streamed survives a reload; there is no `op="streamFile"`. To re-shape the root itself — its `<style>`, mounts, wiring — `op="writeFile"` the new root; a `<liquidos-file>` that stays put keeps its running service. Files the component owns but the user never reads — the behavior script, `data/*.json` — are written with `op="writeFile"`.

Read `<canvas>/feature-requirements.txt` first if it exists; your component should fit the canvas's intent. If the user reports a problem, check `diagnostics/` (and `processes` for "slow / hot / stuck"). One component per turn.

## Components with a backend process

When the component needs a long-running process (a feed reader, a native bridge, a file watcher), wire it inline:

```html
<liquidos-component path="components/feed">
    <liquidos-file path="components/feed/services/<service>.sh" run></liquidos-file>
    <liquidos-file path="components/feed/<entry>.html"></liquidos-file>
</liquidos-component>
```

The `run` element spawns the file at its `path` as a process. Conventional layout:

- service scripts in `components/<name>/services/`
- internal state in `components/<name>/data/`
- diagnostics on **stderr** (the harness logs it) — `stdout` is reserved for the view (below)

Reach for this shape only when something genuinely external is producing the content — a process that watches files, holds a socket, talks to native APIs. Self-contained interactive components don't need it; their DOM goes inline.

### How a service updates the view

A `run` service has two ways to change what the user sees:

- **Rewrite a file.** Write a file that a default `<liquidos-file>` renders; the harness re-renders on the change. Simple, but it replaces the whole rendered region each time — runtime DOM state (typed inputs, scroll, focus) in that region is lost.
- **Patch the live view over stdout.** Everything the service prints to **stdout** is read as `<lqpatch>` markers — the same protocol the agent uses — and applied to the live view as it streams. Target a region the component's `component.html` shell already defined. This lands incremental updates with no re-render, so sibling state survives.

```js
// service.js — append a row to a region the shell defined, live, no re-render
process.stdout.write('<lqpatch op="append" target="#feed-list"><li>' + item + '</li></lqpatch>\n');
```

**stdout is the view-patch channel; stderr is diagnostics.** Keep all service logging on stderr (or a log file) so it never reaches the view.

A service may only patch **its own component** — its selectors resolve within its component's subtree, so it cannot write into another component's region. Within that subtree, patches apply as they arrive; the runtime does not arbitrate, so if two producers write the same element the last write wins (a flicker, never garbled output). Giving each producer its own region so they don't collide is your job to coordinate, not the runtime's to police.

## Feature requirements

`feature-requirements.txt` is user-facing.

- Plain text. No title, no markdown headings.
- One requirement per line, each line a bullet beginning with `- `, written in plain language.
- Requirements must be faithful to the component — no claims about behavior, resources, or limits the component does not actually provide.
- When requirements and implementation disagree, resolve the mismatch instead of preserving inaccurate text.

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

`bash skills/component/scripts/delete-component.sh <canvas-path> <name>` — removes the component and any relationships that wire it. Idempotent.

If the user asked to hide rather than delete, drop the entry from `index.json` and leave the folder.

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

When something looks broken, look in `<component>/diagnostics/` first. Status is in `status.json`; service diagnostics are in `service.log` (stderr — a service's stdout is its view-patch channel, not a log).

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
