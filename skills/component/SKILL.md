---
name: component
description: Create and modify LiquidOS canvas components
triggers:
  - User asks to create a component
  - User asks to update a component
  - User asks to build visible UI
---

# Component

A component is a folder. The minimum contract is two files:

- **`component.html`** — the entry. The canvas paints it.
- **`feature-requirements.txt`** — the user-facing description of what the component does.

Everything else (data files, services, scripts, native binaries) is the agent's choice. The folder is yours; arrange it however the component needs.

## What `component.html` is

`component.html` is HTML. The canvas inserts it. Inside, the agent uses harness-shipped custom elements to declare what should be observed, run, and presented. The three you'll reach for:

```html
<liquidos-component path="components/<name>">
    <liquidos-file path="components/<name>/start.sh" run></liquidos-file>
    <liquidos-file path="components/<name>/view.json"></liquidos-file>
    <liquidos-file path="components/<name>/functions.js" script></liquidos-file>
</liquidos-component>
```

- **`<liquidos-component path="…">`** wraps the component's content. It provides the standard chrome — the Requirements modal (reads `feature-requirements.txt` next to the file at `path`) and the Repair button (appears automatically when `diagnostics/status.json` records a runtime error).
- **`<liquidos-file path="…">`** has three modes selected by attribute:
  - default — fetches the file and renders it as DOM. If the file is JSON with an `html` field, that field is rendered. Updates morph into the live DOM, preserving in-place state (form values, focus, scroll, custom-element instances).
  - **`run`** — asks the harness to spawn the file as a process. Restarts on changes to the file. Killed when the element disconnects.
  - **`script`** — dynamic-imports the file as an ES module and calls `mount(parentElement)`. Re-runs on file change. Cleanup return drains on each re-mount.
- **`<liquidos-callback>`** wraps any control. Captures the declared event (`on="click"`, `on="submit"`, …) and dispatches a prompt to the agent (POST `/callback`). Pulses the wrapped control while the agent is running.

## Suggested folder layout

The layout below is a *convention* — not a contract. The agent rearranges or simplifies as the component requires.

```
components/<name>/
├── component.html          ← entry. The canvas paints this.
├── feature-requirements.txt
├── view.html               (if you have a service that produces view.json)
├── view.json               (the service's painted output)
├── functions.js            (browser-side interactivity)
├── start.sh                (the service script — spawned by <liquidos-file run>)
├── render.js               (the service body — could be node, python, anything)
├── IO.swift                (native side, if needed)
├── data/                   (anything else the agent persists)
└── diagnostics/
    ├── status.json
    └── service.log
```

Components without a service just have `component.html`, `feature-requirements.txt`, and inline HTML / `<style>` / `<liquidos-callback>` inside the component file. Components with rich runtime state have a service file referenced by `<liquidos-file run>` that does whatever it wants — open ports, watch files, talk to native APIs.

## Browser-side JavaScript

All browser-side JS goes through `<liquidos-file script>`. The script is an ES module exporting `mount(surface)`:

```js
export const mount = (surface) => {
    // Wire up listeners, create resources. Scope queries with surface.querySelector(...).
    // Return a cleanup function.
    return () => { /* tear down */ };
};
```

**Do not** put any JavaScript-executing constructs inside `view.html`:

- No `<script>` tags. They don't execute when injected via `innerHTML`.
- No inline event handlers (`onclick=`, `onerror=`, `onload=`, `onchange=`, `onsubmit=`, etc.). They bypass `mount(surface)` lifecycle — no scoping, no cleanup, no instance isolation, accumulating listeners on every progressive update.
- No `javascript:` URLs.

Use `<liquidos-callback>` for user-initiated callbacks routed through the agent. Use `mount(surface)` for everything else.

### Contract rules

These aren't style preferences — components fail subtly when they're broken:

- **`mount()` may run more than once.** Anything the content depends on can change (view.json updates, functions.js edits) and re-mount. Setup must be idempotent — if you allocate an audio context in `mount()`, clean it up in the return.
- **The return value cleans up the previous instance.** Either form works:
  - `return () => { ... }` — a plain cleanup function.
  - `return { destroy: () => { ... } }` — an object with a `.destroy()` method.

  Without a cleanup return, listeners and timers accumulate across re-mounts.
- **HTML emitted into the DOM must be deterministic.** Same inputs, same output. No `Math.random()` in ids, classes, gradient keys, or anything else that's rendered. The morph diff treats different content as a real change, replaying CSS entry animations and disrupting in-place state.

### Subscribing to workspace events

Inside `functions.js` you can subscribe to workspace file changes for paths your component cares about:

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

## Feature Requirements

Components define a `feature-requirements.txt` so they behave consistently. This file is user-facing.

**Format:** plain text. No title, no markdown headings, no `# Component Name` at the top. The file body is just the requirements, one per line.

- Write requirements in plain language, not implementation jargon.
- Each requirement should be simple, specific, and non-redundant.
- Requirements must be faithful to the component: do not claim behavior, resources, permissions, or limits that the component does not actually provide.
- When requirements and implementation disagree, resolve the mismatch instead of preserving inaccurate text.

### Repair (missing, empty, or unreadable)

When `feature-requirements.txt` is missing, empty, or fails to load, `<liquidos-component>` surfaces a **Generate** button in the Requirements modal. Clicking it dispatches the agent with a find-or-create prompt — and *find* comes first:

1. **Find it.** The file may have been renamed or left somewhere unexpected. Check the component folder.
2. **Restore it.** If the file is gone or unsalvageable, check git history (`git log -- '<path>/feature-requirements.txt'`) for the last good version.
3. **Create it.** Only as a last resort, read the component's implementation (`component.html`, `functions.js`, any service files) and write a faithful requirements file in plain language.

## Creating a component

1. Read `<canvas>/feature-requirements.txt` if it exists. It describes the canvas's intent (what it's for, how its components should feel together). Use it as context — your component should fit the canvas, not pull against it.
2. Create the folder `<canvas>/components/<name>/`.
3. Write `feature-requirements.txt` describing what the user asked for, in plain language.
4. Write `component.html` with the `<liquidos-component>` wrapper and whatever tags / inline HTML the component needs. Start with a placeholder showing the next intended action.
5. Add the component's path to `<canvas>/input.json`'s `components` array:
   ```json
   { "components": ["components/<name>/component.html"] }
   ```
6. Do the work. Between each meaningful step, write `component.html` (or `view.html` if you're using a render service) with the partial output and the current next-intended-action. See "Progressive view updates" below for the locking convention.
7. Update `feature-requirements.txt` if anything was learned about the requirements during the work.

Do not touch any component other than the one being created.

## Updating an existing component

1. Read `<canvas>/components/<name>/feature-requirements.txt` to confirm the component's purpose. If the user is reporting a problem, also check `<name>/diagnostics/`.
2. Read `<canvas>/feature-requirements.txt` if it exists. The canvas's intent is the context your changes need to fit; don't drift away from it without reason.
3. Write `component.html` (or `view.html`) with a placeholder showing the next intended action. Disable inputs that would mutate the same data the agent is about to change.
4. Do the work. Between each meaningful step, write the partial output and the current next-intended-action. Keep the inputs disabled the whole time.
5. Write the final output. Re-enable the inputs.
6. Update `feature-requirements.txt` if anything was learned.

Do not touch any component other than the one being updated.

## Offer actions, don't just display state

LiquidOS components are rendered by an agent that can act for the user — fetch data, repair errors, regenerate content, change scope, follow up. Whenever a view shows something the user might want to act on, include a `<liquidos-callback>` that does the action. This is what makes LiquidOS an AI OS rather than a static document viewer; the affordances are why the user is here.

The default is "offer the action." Avoid:

- An error message with no fix button.
- An empty state ("No items yet") with no way to add one.
- A data display the user could plausibly want refreshed, filtered, or sorted, with no controls for any of those.
- A configuration the user might want to change, shown read-only.

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

The exception is the escalation case (see Diagnostics → Escalation below): when the agent has determined it cannot perform the action — typically a harness or infrastructure bug — it says so plainly and stops. A button that loops back to the same failure is worse than no button.

## Declare what you need; work in less

Two responsibilities, both on the component:

- **Declare how much room the component needs**, no more. The component's outermost element should carry a `min-width` (and where useful a `width` / preferred size) that reflects the *actual* content minimum — the width below which the component genuinely stops working. Don't pad the declaration with comfort margins. If the natural minimum is 280px, declare 280px. If a piano keyboard needs 720px to fit all its keys, declare 720px. This is the signal the presentation reads to decide layout — over-declaring wastes its space; under-declaring lets it crush you.
- **Still work when given less than declared.** The presentation may give less than your declared minimum anyway — a narrow slot, a stacked layout, a small modal. The component should degrade gracefully: `max-width: 100%`, `min-width: 0` on flex children that can compress, `overflow-x: auto` for intrinsically-wide content (keyboards, tables, code) so it scrolls instead of spilling.

The component is a guest in a slot it didn't pick. Same component may render in a 3D scene with fixed-size cards, in the Requirements modal at half-width, in a stack presentation at full-width. The declared minimum tells those presentations what you actually need; the graceful-degradation behavior covers them ignoring it.

## Catch only when you can recover

`<liquidos-component>` watches its own `diagnostics/status.json`. The harness's error router installs `window.error` and `unhandledrejection` listeners that attribute a thrown error to the component whose `functions.js` is on the stack, write it under `runtime` in `status.json`, and the chrome surfaces a Repair button.

This means: **don't catch errors you cannot recover from.** A `try/catch` that ends in `setStatus("Bad state: " + error.message, false)` — or any other "rebrand the failure as a red message" — hides the problem from both the agent and the harness. The component looks broken to the user, but to the listener it looks fine, so no Repair is offered.

Catch when you have an actual recovery move:

- **Transient connection states.** `source.onerror = () => setStatus("Reconnecting…")` — SSE auto-reconnects; this is UI state, not an error.
- **Real fallback.** `fetch(url).catch(() => useCache())` where there's a cache to fall back to.
- **Input validation.** "Please enter a number" on bad user input — the failure isn't a bug.

Let the rest throw. A failed `JSON.parse` on an SSE frame, an unexpected schema, a "tried to call .map on undefined" — the component has no plan for these, so the Repair button *is* the plan.

## Diagnostics

When something looks broken, look in `<component>/diagnostics/` first. Status is in `status.json`; service stdout/stderr is in `service.log`.

### Escalation

If you've isolated the problem to the harness or infrastructure and there is no fix you can make from inside the component, do not invent a workaround that bypasses the contract (no inline JS smuggling, no `<img onerror>` tricks, no parallel mount mechanisms).

Communicate with the user through the canvas — write the escalation into `component.html` so it appears as the component's view. The report should be visible without the user having to open a file or terminal.

A useful escalation view names:
- What was reported broken.
- What you confirmed works (e.g., "the JS parses, the file is at the expected path").
- What you suspect is wrong.
- That you are stopping rather than working around it.

Then stop. The user reads the canvas, fixes the harness, and may ask you to retry.

## Progressive view updates

While the agent is mutating a component, intermediate writes must set the `disabled` attribute on any inputs that would mutate the same data. Disabled inputs don't fire events. Otherwise concurrent user input would race the in-progress mutation and silently lose edits.

Inputs wrapped in `<liquidos-callback>` are auto-disabled by the harness while their callback's request is in flight, so they don't need manual `disabled` for that case. The rule below covers plain HTML inputs whose value the agent rewrites programmatically.

Before each rewrite, narrate the intent: which inputs are being disabled or restored, and why.

### Example

Prompt: "fix the spelling". Component: `components/note/`.

**Before the prompt — the existing markup, fully interactive.**

```html
<liquidos-component path="components/note">
    <div style="padding:1rem;">
        <h2>Note</h2>
        <textarea name="text">i wnat to byu groceries tommorow</textarea>
    </div>
</liquidos-component>
```

**Placeholder write — textarea disabled.**

> *Narration:* "I'm about to mutate `components/note/component.html`. I need to disable the textarea so the user can't type a competing edit before I finish."

```html
<liquidos-component path="components/note">
    <div style="padding:1rem;">
        <h2>Note</h2>
        <p>Checking spelling…</p>
        <textarea name="text" disabled>i wnat to byu groceries tommorow</textarea>
    </div>
</liquidos-component>
```

**Final write — `disabled` removed.**

```html
<liquidos-component path="components/note">
    <div style="padding:1rem;">
        <h2>Note</h2>
        <textarea name="text">I want to buy groceries tomorrow.</textarea>
    </div>
</liquidos-component>
```

## Removing

1. Remove the component path from `<canvas>/input.json`.
2. Delete the folder at `<canvas>/components/<name>/` (skip this if user asked to hide the component).
3. Respond as done.

## Prompt Callbacks

For functionality that would benefit from the dynamism or intelligence of an agent, or for build-on-demand behavior, use `<liquidos-callback>`.

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

Attributes:

- `on` — the DOM event that triggers the callback (`submit`, `click`, `change`, …).
- `prompt` — the prompt template. `{{field}}` substitutions are read from form fields.
- `prompt-from` — alternative to `prompt`; uses the entire current value of the named field as the prompt.
- `values` — required when `prompt` uses placeholders. Comma-separated allowlist of field names. Values are read the way the wrapped form would submit them (checked radio, selected option, typed text).
- `scope` — the path of the thing calling back, canvas-relative (`components/chat`). The harness resolves it before dispatching.

While a callback's request is in flight, the harness automatically disables and pulses it — no manual loading state needed.

## Canvas-local Files

Files referenced by your `component.html` paths are served by the harness. Write workspace-relative paths in `<liquidos-file>` attributes:

```html
<liquidos-file path="components/random-image/photo.jpg"></liquidos-file>
```

For files outside the workspace, serve them via a local HTTP server in your component's service:

```bash
cd ~/Pictures
python3 -m http.server 8000
```

Then reference via HTTP URL inside your view:

```html
<img src="http://localhost:8000/example.png" style="max-width:100%">
```

The harness doesn't proxy arbitrary `file://` paths or absolute filesystem paths.
