---
name: component-creator
description: Create and modify LiquidOS canvas components
triggers:
  - User asks to create a component
  - User asks to update a component
  - User asks to build visible UI
---

# Component Guide

## Components

Every component is a folder under the canvas's `components/` with the same shape:

```
components/<name>/
├── feature-requirements.md   Required. User-facing description of what the component does.
├── view.json                 Required. Rendered by render.js; the harness paints this.
├── view.html                 Required. Agent's editing surface — HTML template with placeholders.
├── functions.js              Optional. ES module exporting mount(surface) for browser-side JS.
├── data/                     Optional. Component-owned state (json, sql, etc).
└── services/
    ├── start.sh              Required. Harness invokes to launch services.
    ├── render.js             Required. Watches view.html, substitutes placeholders, writes view.json.
    └── IO.swift              Optional. Native macOS side; compiled and launched by start.sh if present.
```

### How edits flow

The agent's primary editing surface is `view.html`. `render.js` watches it via `fs.watch`, substitutes runtime values at write time, and emits `view.json`. The harness paints `view.json`. Editing `view.html` does NOT restart the service — `render.js` notices and re-emits.

Editing `render.js`, `IO.swift`, or `start.sh` *does* restart the service (they live under `services/**`, which the harness watches for restarts).

### Mustache placeholders

`view.html` may use `{{name}}` placeholders that `render.js` substitutes at write time. The default scaffold exposes:

- `{{port}}` — render.js's ephemeral HTTP port (useful if `functions.js` or external clients need a known endpoint).
- `{{origin}}` — `http://127.0.0.1:{{port}}`.
- `{{dispatchId}}` — the dispatch id passed to `start.sh`.

Add more by extending render.js.

### Browser-side JavaScript

Do not put `<script>` tags inside `view.html`. Scripts injected via `innerHTML` do not execute (browser spec). Put browser-side code in `functions.js` as an ES module exporting `mount(surface)`:

```js
export const mount = (surface) => {
    // Wire up listeners, create resources. Scope queries with surface.querySelector(...).
    // Optionally return a cleanup function; the harness calls it before re-mounting.
}
```

The harness imports `functions.js` as a real ES module and calls `mount(surface)` with the component's DOM root. `mount` can return a cleanup function that runs before the next re-mount.

### Adding resources

The scaffold's `render.js` auto-declares `resources.functions` in `view.json` when `functions.js` exists. For other resources (images, fonts, additional modules), extend `render.js` to add them to the view object it writes.

### Scaffolding, not rails

Every generated file has a comment header explaining its role and what's safe to change. Restructure the component as needed: rename files, add data files, ditch `IO.swift`, replace `render.js` with a different renderer. The only invariants the harness needs are that `view.json` eventually gets written and `start.sh` stays alive while services should run.

## Service Harness

The harness invokes `services/start.sh` with a unique dispatch id:

```sh
services/start.sh <dispatch-id>
```

Treat the dispatch id as a function parameter. Use it in `start.sh` to namespace collision-prone runtime resources (sockets, temp files, native binaries). The default scaffold exports `LIQUIDOS_DISPATCH_ID` for child processes.

The harness starts and stops the service process group. `start.sh` should stay alive while the service is alive and should not daemonize or detach child processes.

The harness watches:
- `view.json` for canvas repaints.
- `services/**` for service restarts.

Files outside `services/` (including `view.html`, `functions.js`, `data/`) are component-owned and do not trigger restarts. `render.js` handles `view.html` changes itself.

## Feature Requirements

Components define a `feature-requirements.md` so they behave consistently.
This file is user-facing.
Write requirements in plain language, not implementation jargon.
Each requirement should be simple, specific, and non-redundant.
Requirements must be faithful to the component: do not claim behavior, resources, permissions, or limits that the component does not actually provide or intend to provide.
When requirements and implementation disagree, resolve the mismatch instead of preserving inaccurate text.

## Creating a component

1. Run the scaffold script. It creates the folder, writes the loading-state files, drops a no-op `functions.js`, shells out `services/{start.sh, render.js, IO.swift}`, and registers the component in `input.json`:

   ```sh
   bash skills/component-creator/scripts/create-component.sh <canvas-path> <component-name>
   ```

   Do not duplicate any of those steps by hand. Do not create the folder, write any of the scaffolded files, or edit `input.json` separately — the script has already done it.

2. Write `feature-requirements.md` describing what the user asked for, in plain language.

3. Write `view.html` with a placeholder showing the next intended action. Disable any inputs that would mutate the same data the agent is about to change.

4. Do the work. Between each meaningful step, write `view.html` with the partial output and the current next-intended-action. Keep the inputs disabled the whole time. See "Progressive view updates" below for the locking convention.

5. Write `view.html` with the final output. Re-enable the inputs.

6. Update `feature-requirements.md` if anything was learned about the requirements during the work.

The scaffolded files are starting clay. Each has a comment header explaining what's safe to change. Restructure as needed — rename files, delete `IO.swift` if not needed, replace `render.js` — whatever fits the component.

Do not touch any component other than the one being created.

## Updating an existing component

1. Read `<canvas>/components/<component_name>/feature-requirements.md` to confirm the component's purpose.

2. Write `view.html` with a placeholder showing the next intended action. Disable any inputs that would mutate the same data the agent is about to change.

3. Do the work. Between each meaningful step, write `view.html` with the partial output and the current next-intended-action. Keep the inputs disabled the whole time. See "Progressive view updates" below for the locking convention.

4. Write `view.html` with the final output. Re-enable the inputs.

5. Update `feature-requirements.md` if anything was learned about the requirements during the work.

Do not touch any component other than the one being updated.

## Progressive view updates

While the agent is mutating a component, intermediate `view.html` rewrites must set the `disabled` attribute on any inputs that would mutate the same data. Disabled inputs don't fire events. Otherwise concurrent user input would race the in-progress mutation and silently lose edits.

Inputs wrapped in `<liquidos-callback>` are auto-disabled by the harness while their callback's request is in flight, so they don't need manual `disabled` for that case. The rule below covers plain HTML inputs whose value the agent rewrites programmatically — those have no auto-lock.

Before each rewrite, narrate the intent: which inputs are being disabled or restored, and why. This makes the lock-and-release pattern visible in the agent's reasoning and habitual over time.

### Example

Prompt: "fix the spelling". Component: `components/note/`. (The work is triggered from outside the component — e.g., the prompt bar — not by a callback inside it.)

**Before the prompt — the existing `view.html`, fully interactive.**

```html
<div style="padding:1rem;">
    <h2>Note</h2>
    <textarea name="text">i wnat to byu groceries tommorow</textarea>
</div>
```

**Placeholder write — textarea disabled.**

> *Narration before writing:* "I'm about to mutate `components/note/view.html`. I need to disable the textarea so the user can't type a competing edit before I finish."

```html
<div style="padding:1rem;">
    <h2>Note</h2>
    <p>Checking spelling…</p>
    <textarea name="text" disabled>i wnat to byu groceries tommorow</textarea>
</div>
```

**Partial write — textarea still disabled.**

```html
<div style="padding:1rem;">
    <h2>Note</h2>
    <p>Checking spelling… 3 of 5 words.</p>
    <textarea name="text" disabled>I want to buy groceries tommorow</textarea>
</div>
```

**Final write — `disabled` removed.**

> *Narration before writing:* "Spell check is done. I'll write the final view with `disabled` removed so the user can edit again."

```html
<div style="padding:1rem;">
    <h2>Note</h2>
    <textarea name="text">I want to buy groceries tomorrow.</textarea>
</div>
```

## Removing

1. Prompt arrives indicating the desire to remove or delete one or many components.
2. Agent removes component path from `<canvas>/input.json`.
3. Agent deletes component at `<canvas>/components/<component_name>/` (skip this if user asked to hide component).
4. Agent responds as done.

## Prompt Callbacks

For functionality that would benefit from the dynamism or intelligence of an agent, or if the building of something can be deferred until interacted with use Prompt Callbacks.

`<liquidos-callback>`
Custom HTML element used to declare an agent callback action. Wrap any control(s) with it.

`on`
The DOM event that triggers the callback, e.g. `submit`, `click`, or `change`.

`prompt`
The action performed and/or the user's intent. May contain `{{field}}` placeholders.

`prompt-from`
Alternative to `prompt`: use the entire current value of the named field as the prompt.

`values` 
Required when `prompt` uses placeholders. 
It should be a comma-separated allowlist of field names the callback can read.
Field values are read the way the wrapped form would submit them, so a checked radio, a selected option, or typed text all report their current value.

`scope` 
The path of the thing calling back. 
It should be canvas-relative in markup, such as `components/chat`. 
LiquidOS resolves it to an absolute filesystem path before sending it to the agent.

Example:

```html
<liquidos-callback
  on="submit"
  scope="components/chat"
  values="message"
  prompt="User wants to send this message: {{message}}"
>
  <form>
    <input name="message" placeholder="Message" />
    <button type="submit">Send</button>
  </form>
</liquidos-callback>
```

While a callback's request is in flight, LiquidOS automatically disables and pulses it until the agent responds — you do not need to build your own loading or disabled state.


## Canvas-Local Files

Files copied into the canvas/component folder are available to components only through declared resources.
Do not write direct browser paths like `src="components/example/file.jpg"`; those resolve against the app server root, not the canvas folder.

Correct pattern after copying a file to `<canvas>/components/random-image/photo.jpg`:

```json
{
  "title": "Random Image",
  "html": "<img src=\"{{ resources.photo.url }}\" style=\"max-width:100%\">",
  "resources": {
    "photo": {
      "path": "components/random-image/photo.jpg",
      "mime": "image/jpeg"
    }
  }
}
```

`resources.*.path` should be canvas-relative or component-local only. LiquidOS turns it into a served `/component/.../resources/...` URL.

## Local Files From Tiny Servers

When a component needs files that exist outside the canvas folder, do not use `file://` URLs and do not point `resources.*.path` at arbitrary absolute filesystem paths.

Serve the folder separately, for example:

```bash
cd ~/Pictures
python3 -m http.server 8000
```

Then reference files using HTTP URLs:

```json
{
  "title": "Local image",
  "html": "<img src=\"{{ resources.image.url }}\" style=\"max-width:100%\">",
  "resources": {
    "image": {
      "url": "http://localhost:8000/example.png",
      "mime": "image/png"
    }
  }
}
```

For non-renderable files, link to the served URL:

```json
{
  "title": "Local file",
  "html": "<a href=\"{{ resources.file.url }}\" download>Download file</a>",
  "resources": {
    "file": {
      "url": "http://localhost:8000/report.pdf",
      "mime": "application/pdf"
    }
  }
}
```

Use `resources.*.path` only for files inside the canvas/component folder that LiquidOS should watch and serve. Use `resources.*.url` for files served by the Mac app local static server, Python, or another local HTTP server.
