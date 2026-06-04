---
name: component
description: Create and modify LiquidOS canvas components
triggers:
  - User asks to create a component
  - User asks to update a component
  - User asks to build visible UI
---

# Component

Every component is a folder under the canvas's `components/`. Inside, the live state lives in `presented/`. Multi-file changes are staged via a sandbox (see `../testing/SKILL.md`) and committed via the source workspace's `/workspace/writes` endpoint.

The harness's actual contract is small: it reads `presented/view.json` and invokes `presented/services/start.sh` if it exists. Everything else in the layout below is a recommendation the scaffold ships; the agent can replace any of it with a different approach.

```
components/<name>/
├── presented/                ← what the harness reads and paints
│   ├── feature-requirements.txt   User-facing description of what the component does.
│   ├── view.json                 Required. The harness paints this — it's the contract.
│   ├── view.html                 Scaffold default: template render.js reads.
│   ├── functions.js              Optional. ES module exporting mount(surface) for browser-side JS.
│   └── services/
│       ├── start.sh              Invoked by the harness; needed only if the component has services.
│       ├── render.js             Scaffold default: watches view.html, writes view.json.
│       └── IO.swift              Optional. Native macOS side; compiled and launched by start.sh if present.
├── data/                     ← persistent state
├── diagnostics/              ← harness-written status and logs; agent reads here when debugging
│   ├── status.json               Current state per category (mount, service, view).
│   └── service.log               Append-only stdout/stderr from start.sh and children.
└── state.json             ← optional per-component canvas state (position, etc.) written
                              by the canvas's canvas.js. Not the component's concern.
```

The scaffold ships `view.html` + `render.js` because most components benefit from a template-and-substitute renderer that handles dynamic port injection. A component that doesn't need runtime substitution can produce `view.json` directly (e.g., by writing it from `render.js` with no template, or by having no `render.js` at all and treating `view.json` as the agent's editing surface).

### How edits flow

The agent's primary editing surface is `presented/view.html`. `render.js` watches it via `fs.watch`, substitutes runtime values at write time, and emits `presented/view.json`. The harness paints `view.json`. Editing `view.html` does NOT restart the service — `render.js` notices and re-emits.

Editing `render.js`, `IO.swift`, or `start.sh` *does* restart the service.

### In-place edits vs sandbox-and-apply

The agent has two modes, picked by the shape of the change:

**In place** — for single-file edits (the common case: progressive `view.html` rewrites during work). Write directly to `presented/<file>`. Each write is observable to the user and tracked by the harness watcher. This is the default.

**Sandbox and apply** — for multi-file changes that would leave the component broken if applied one at a time (e.g., a `view.html` ↔ `functions.js` refactor where attribute selectors change in both). Boot a sandbox via `../testing/SKILL.md`, make all the edits in the sandbox copy, verify, then atomically apply by POSTing to the **source** server's writes endpoint:

```sh
curl -X POST http://127.0.0.1:<source-port>/workspace/writes \
    -H 'content-type: application/json' \
    -d '{
      "sandbox": "/var/folders/.../sandbox-workspace/Workspace.liquidos",
      "writes": [
        { "path": "home/components/foo/presented/view.html", "from": "home/components/foo/presented/view.html" },
        { "path": "home/components/foo/presented/functions.js", "from": "home/components/foo/presented/functions.js" }
      ]
    }'
```

The endpoint pauses the workspace watcher, processes the batch, then fires one refresh — the user sees one coherent transition, not a flicker per file. Each `write` entry is either `{ path, content }` (inline) or `{ path, from }` (copy from disk; relative `from` resolves against the optional top-level `sandbox`). Paths are workspace-relative.

### Mustache placeholders

`view.html` may use `{{name}}` placeholders that `render.js` substitutes at write time. The default scaffold exposes:

- `{{port}}` — render.js's ephemeral HTTP port (useful if `functions.js` or external clients need a known endpoint).
- `{{origin}}` — `http://127.0.0.1:{{port}}`.
- `{{dispatchId}}` — the dispatch id passed to `start.sh`.

Add more by extending render.js.

### Browser-side JavaScript

All browser-side JS goes in `functions.js` as an ES module exporting `mount(surface)`. The harness imports it as a real module, calls `mount(surface)` with the component's DOM root, and calls the returned cleanup function before the next re-mount.

```js
export const mount = (surface) => {
    // Wire up listeners, create resources. Scope queries with surface.querySelector(...).
    // Optionally return a cleanup function.
}
```

**Do not** put any JavaScript-executing constructs inside `view.html`:
- No `<script>` tags. They don't execute when injected via `innerHTML`.
- No inline event handlers (`onclick=`, `onerror=`, `onload=`, `onchange=`, `onsubmit=`, etc.). They *do* execute via `innerHTML`, but they bypass the `mount(surface)` lifecycle — no scoping, no cleanup, no instance isolation, accumulating listeners on every progressive update.
- No `javascript:` URLs.

Use `<liquidos-callback>` for user-initiated callbacks routed through the agent. Use `mount(surface)` for everything else.

### Contract rules the harness relies on

These aren't style preferences — the harness fails subtly when they're broken. Past versions of components have re-introduced these mistakes after refactors. If you're regenerating a component, check each:

- **`mount()` may run more than once.** Whenever `view.json`'s html or resources change, the harness destroys the previous mount and runs `mount(surface)` again. Setup must be idempotent — if a service restart bumps the html and you allocate an audio context in `mount()`, you'll have two audio contexts unless you cleaned up the previous one.

- **The return value cleans up the previous instance.** The harness accepts either form:
  - `return () => { ... }` — a plain cleanup function.
  - `return { destroy: () => { ... } }` — an object with a `.destroy()` method.

  Pick either; the harness calls whichever it gets. Without a cleanup return, listeners and timers accumulate across re-mounts.

- **HTML served via `view.json` must be deterministic.** Given the same inputs, the same output. **No `Math.random()` in ids, classes, gradient keys, or anything else that's rendered into the html.** The harness diffs old vs new html to decide whether to re-mount; random values force a re-mount on every render and replay any CSS entry animations on the affected elements.

- **No `<script>` tags or inline event handlers in `view.html`.** Already covered above, but worth restating here as a rule: this is a harness contract, not a guideline. Use `mount(surface)` or `<liquidos-callback>`.

- **Cache-bust resource URLs change when files change.** The harness imports `functions.js` via dynamic import with the file's mtime as the cache-bust query string. If you replace `functions.js`, the harness re-imports automatically. Don't try to hand-roll your own cache invalidation; you'll fight the framework.

### Adding resources

The scaffold's `render.js` auto-declares `resources.functions` in `view.json` when `functions.js` exists. For other resources (images, fonts, additional modules), extend `render.js` to add them to the view object it writes.

### Scaffolding, not rails

Every generated file has a comment header explaining its role and what's safe to change. Restructure the component as needed: rename files, add data files, ditch `IO.swift`, replace `render.js` with a different renderer. The only invariants the harness needs are that `view.json` eventually gets written and `start.sh` stays alive while services should run.

## Service Harness

The harness invokes `presented/services/start.sh` with a unique dispatch id:

```sh
presented/services/start.sh <dispatch-id>
```

Treat the dispatch id as a function parameter. Use it in `start.sh` to namespace collision-prone runtime resources (sockets, temp files, native binaries). The default scaffold exports `LIQUIDOS_DISPATCH_ID` for child processes.

The harness starts and stops the service process group. `start.sh` should stay alive while the service is alive and should not daemonize or detach child processes.

The harness watches the component folder recursively. Edits inside `presented/services/` restart the service; edits to `presented/view.html` are handled by `render.js` without a restart.

## Feature Requirements

Components define a `feature-requirements.txt` so they behave consistently.
This file is user-facing.

**Format:** plain text. No title, no markdown headings, no `# Component Name` at the top. The component's name and label live in `view.json`'s `title` field; the requirements modal reads them from there and labels the file separately. The file body is just the requirements, one per line.

Write requirements in plain language, not implementation jargon.
Each requirement should be simple, specific, and non-redundant.
Requirements must be faithful to the component: do not claim behavior, resources, permissions, or limits that the component does not actually provide or intend to provide.
When requirements and implementation disagree, resolve the mismatch instead of preserving inaccurate text.

### Repair (missing, empty, or unreadable)

When `feature-requirements.txt` is missing, empty, or fails to load, the harness surfaces a **Repair** button on the component's requirements flip-back. Clicking it dispatches the agent with a find-or-create prompt — and *find* comes first. Try in this order before writing anything new:

1. **Find it.** The file may have been renamed, moved out of `presented/`, or left behind in `.presented/` after a botched swap. Check the component folder.
2. **Restore it.** If the file is gone or unsalvageable, check git history (`git log -- '<path>/feature-requirements.txt'`) for the last good version and bring it back.
3. **Create it.** Only as a last resort, read the component's implementation (`view.html`, `functions.js`, `services/*`) and write a faithful requirements file in plain language. Don't ask the user to write it from scratch — that's what the button just spared them.

The same Repair affordance covers the empty case (file exists but has no content). Treat it identically: find existing requirements first, fall back to writing them from the code.

## Creating a component

1. Run the scaffold script. It creates the folder, writes the loading-state files, drops a no-op `functions.js`, shells out `services/{start.sh, render.js, IO.swift}`, and registers the component in `input.json`:

   ```sh
   bash skills/component/scripts/create-component.sh <canvas-path> <component-name>
   ```

   Do not duplicate any of those steps by hand. Do not create the folder, write any of the scaffolded files, or edit `input.json` separately — the script has already done it.

2. Read `<canvas>/canvas-requirements.txt` if it exists. It describes the canvas's intent (what it's for, how its cards should feel together). Use it as context — your component should fit the canvas, not pull against it.

3. Write `feature-requirements.txt` describing what the user asked for, in plain language.

4. Write `view.html` with a placeholder showing the next intended action. Disable any inputs that would mutate the same data the agent is about to change.

5. Do the work. Between each meaningful step, write `view.html` with the partial output and the current next-intended-action. Keep the inputs disabled the whole time. See "Progressive view updates" below for the locking convention.

6. Write `view.html` with the final output. Re-enable the inputs.

7. Update `feature-requirements.txt` if anything was learned about the requirements during the work.

The scaffolded files are starting clay. Each has a comment header explaining what's safe to change. Restructure as needed — rename files, delete `IO.swift` if not needed, replace `render.js` — whatever fits the component.

Do not touch any component other than the one being created.

## Updating an existing component

1. Read `<canvas>/components/<component_name>/presented/feature-requirements.txt` to confirm the component's purpose. If the user is reporting a problem, also check the `diagnostics/` folder.

2. Read `<canvas>/canvas-requirements.txt` if it exists. The canvas's intent is the context your changes need to fit; don't drift away from it without reason.

3. Write `view.html` with a placeholder showing the next intended action. Disable any inputs that would mutate the same data the agent is about to change.

4. Do the work. Between each meaningful step, write `view.html` with the partial output and the current next-intended-action. Keep the inputs disabled the whole time. See "Progressive view updates" below for the locking convention.

5. Write `view.html` with the final output. Re-enable the inputs.

6. Update `feature-requirements.txt` if anything was learned about the requirements during the work.

Do not touch any component other than the one being updated.

## Offer actions, don't just display state

LiquidOS components are rendered by an agent that can act for the user — fetch data, repair errors, regenerate content, change scope, follow up. Whenever a view shows something the user might want to act on, the agent should include a `<liquidos-callback>` that does the action. This is what makes LiquidOS an AI OS rather than a static document viewer; the affordances are why the user is here.

The default is "offer the action." Avoid:

- An error message with no fix button. If the agent can re-attempt, retry differently, or repair, include a callback that does that.
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

## Diagnostics

When something looks broken, look in `<component>/diagnostics/` first. The harness writes status info and logs there. The agent reads them; the agent does not write them.

### Escalation

If you've isolated the problem to the harness or infrastructure and there is no fix you can make from inside the component, do not invent a workaround that bypasses the contract (no inline JS smuggling, no `<img onerror>` tricks, no parallel mount mechanisms).

Communicate with the user through the canvas — write the escalation into `view.html` so it appears as the component's view. The report should be visible without the user having to open a file or terminal.

A useful escalation view names:
- What was reported broken.
- What you confirmed works (e.g., "the JS parses, the file is at the expected path").
- What you suspect is wrong (e.g., "the resource URL `…` returns 404; I think the URL the harness generates doesn't match the route it serves").
- That you are stopping rather than working around it.

Then stop. The user reads the canvas, fixes the harness, and may ask you to retry. Workarounds that violate the markup rule above are worse than no fix — they make the component harder to maintain and hide the underlying bug.

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
