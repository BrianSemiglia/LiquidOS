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

`component.html` is the component's initial body. The harness paints it, and re-renders on every later change to the file. A `<liquidos-file>` mount that stays put across an edit (same `path`, same attributes) keeps its running service and hydrated children; change its `path` or attributes and the old service tears down and a new one starts.

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
- **`<liquidos-file path="…" script>`** runs a script you provide as an ES module that exports `mount(surface)` — for browser-side state, listeners, anything the DOM alone doesn't cover. It re-runs whenever the component re-renders, so make setup idempotent and return a cleanup function. Split it into more files if you like — import them with plain relative paths (`import { fmt } from './format.js'`); editing any module it imports re-runs the component, same as editing the script. Keep emitted HTML deterministic (no `Math.random()` in IDs or classes) or every re-render looks like new content. Don't use inline `<script>` or `on*=` handlers — injected `<script>` never runs, and inline handlers leak on every re-render.
- **`<liquidos-file path="…" run>`** asks the harness to spawn the file as a long-running process. Use this when the component genuinely needs a backend — watching files, holding a socket, calling native APIs. It restarts when the file, or any module it imports, changes.

The default `<liquidos-file path="…"></liquidos-file>` (no attributes) fetches the file and renders its content. Pair it with a `run` process when something is producing painted output from outside the agent's stream.

## Building and changing the body

Create the component if it isn't on the canvas yet, then **stream its HTML elements in — one element per patch.** Never a block of markup with its children inline: a product card is its frame appended first, then its image, heading, price, and button each appended into it. The user watches every element land.

- **Create** (only when it doesn't exist): `bash skills/component/scripts/create-component.sh <canvas-path> <name>`. That registers it and gives you an empty `<liquidos-component>` — the root you stream into.
- **Stream** element by element: `op="append"` / `"prepend"` one element to a selector **already in the live DOM** — the component root, or a parent you appended a moment ago. To nest, append the parent (empty) first, then append each child into it. `op="replace"` swaps an element (or the `<style>` for a theme), `op="setAttr"` retunes one, `op="remove"` drops one.

A patch only lands if its target is already in the live DOM — aim at a container you haven't appended yet and nothing shows. Patches aimed inside the `<liquidos-component>` persist back to `component.html`, so what you streamed survives a reload. To re-shape the root itself — its `<style>`, mounts, wiring — `op="writeFile"` the new root; a `<liquidos-file>` that stays put keeps its running service. Files the component owns but the user never reads — the behavior script, `data/*.json` — are written with `op="writeFile"`. Don't `writeFile` the whole view: it lands all at once, off-stream, and the user watches nothing grow.

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
- the view: the service writes its own files (a `<liquidos-file>` renders them; see below); **stdout** and **stderr** are ordinary logs the harness captures

**Native helpers (Swift, etc.) are host-compiled.** Ship the source (`IO.swift`), never the compiled binary. Build it on the running host into a disposable cache (`data/.runtime/`) and `.gitignore` that cache. A compiled binary that travels inside a copied or downloaded workspace is Gatekeeper-blocked on another Mac, costing the user a second "developer cannot be verified" approval on top of the app itself.

Never trust a binary that arrived from elsewhere: if the cached binary carries `com.apple.quarantine`, it came from a copied/downloaded workspace and may not match the `IO.swift` you can read — **rebuild from source** rather than running it, so the binary provably is the visible source. A freshly compiled binary isn't quarantined, so only as a fallback (build skipped) strip `com.apple.quarantine` before launch. See the `programmatic-native` example.

Reach for this shape only when something genuinely external is producing the content — a process that watches files, holds a socket, talks to native APIs. Self-contained interactive components don't need it; their DOM goes inline.

### How a service updates the view

A `run` service has **no view channel of its own** — it changes the view the same way the agent does: by **writing files.** The deciding factor is **persistence** — should the view state survive a reload, or is it transient real-time data?

- **Write your own file — durable.** The service writes a file a `<liquidos-file>` renders (its own fragment, or a `data/*.json` a script reads). The watcher morphs each change into the DOM — only the delta, and sibling runtime state (typed inputs, focus, scroll) is preserved — and the file persists, so the view survives a reload. Each write is a real workspace write, so write at element/line granularity, not per character. Right for durable view state at human-interaction frequency: a list, a feed, a status line.
- **Serve your own content — transient.** Run a localhost HTTP server in the service and have the view consume it with standard browser APIs — `fetch`, or an `EventSource` for a live stream. This updates the live DOM only; **nothing persists**. Right for high-frequency transient data — an audio meter, a cursor, anything updating many times a second. See the `programmatic-native` example.

```js
// service.js — append a row to a list the component renders. Writing the file
// IS the view update: a <liquidos-file path="feed.html"> morphs the new <li> in.
const fs = require('fs');
items.push('<li>' + item + '</li>');
fs.writeFileSync(__dirname + '/../feed.html', '<ul id="feed">' + items.join('') + '</ul>\n');
```

A service has no special output stream — **stdout and stderr are ordinary logs**, neither reaches the view. The view changes only through the files the service writes, and because those files live in the component's own folder a service can only ever touch its own component.

## Feature requirements

`feature-requirements.txt` is user-facing.

- Plain text. No title, no markdown headings.
- One requirement per line, each line a bullet beginning with `- `, written in plain language.
- Requirements must be faithful to the component — no claims about behavior, resources, or limits the component does not actually provide.
- When requirements and implementation disagree, resolve the mismatch instead of preserving inaccurate text.

## Progressive view updates

While the agent is mutating a component, intermediate writes must set `disabled` on any inputs that would mutate the same data. Disabled inputs don't fire events; otherwise concurrent user input races the in-progress mutation and silently loses edits.

Controls wrapped in `<liquidos-callback>` are auto-disabled by the harness while a request for their component is in flight — every callback in the component goes inert together, not just the one that fired — so they don't need manual `disabled` for that case. The rule covers plain HTML inputs whose value the agent rewrites programmatically.

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

When something looks broken, read `<component>/diagnostics/status.json` first. A `run` service's diagnostics are whatever it logs to **stdout or stderr**; that output goes to the server log, not into `diagnostics/`.

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
