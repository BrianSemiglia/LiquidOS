---
name: component-creator
description: Create and modify LiquidOS canvas components
triggers:
  - User asks to create a component
  - User asks to update a component
  - User asks to build visible UI
---

# Component Guide

## Literal components
  
- Slower but more dynamic for tasks that are less clearly defined. Agent can perform work and update as it progresses. Follow this template very closely: `examples/static/`.
  
  <canvas>/components/<component-name>/
  `feature-requirements.md` required
  `view.json`               required, observed to repaint canvas
  
## Programmatic components 
  
Faster and more repeatable for tasks more clearly defined. They should have a render.js that is a tiny component-local server that programmatically produces a view which listens for changes from that server and calls back to it. Follow this template very closely: `examples/programmatic-*/`.
  
  <canvas>/components/<component-name>/
  `feature-requirements.md` required
  `view.json`               required, listens for changes from `render.js`, makes callbacks
  `services/`               required, observed to restart execution
    `start.sh`              required, starts services
    `render.js`             required, produces/updates `view.json`
  `data/`                   optional durable component state (json, sql, etc)


## Service Harness

When a service exists, the harness starts it with:

```sh
services/start.sh <dispatch-id>
```

Treat the dispatch id as a function parameter. Use it in `start.sh` to namespace collision-prone runtime resources such as local sockets, temporary files, native source names, and service instances. Pass only the specific values each child process needs.

The harness starts and stops the service process group. `start.sh` should stay alive while the service is alive and should not daemonize or detach child processes.

The harness observes `view.json` for canvas refreshes and `services/**` for service restarts. Other component files are component-owned and may be organized as needed.

## Feature Requirements

Components define a `feature-requirements.md` so they behave consistently.
This file is user-facing.
Write requirements in plain language, not implementation jargon.
Each requirement should be simple, specific, and non-redundant.
Requirements must be faithful to the component: do not claim behavior, resources, permissions, or limits that the component does not actually provide or intend to provide.
When requirements and implementation disagree, resolve the mismatch instead of preserving inaccurate text.

## Adding/Updating

1. Prompt arrives.
2. Agent creates or finds existing component folder at `<canvas>/components/<component_name>/`.
3. Agent reads `<canvas>/input.json` and preserves every existing key and component path.
4. Agent appends the new component folder path to `<canvas>/input.json` only if adding a new component and only if it is not already present. Existing `view.json` paths are also valid and should be preserved.
5. Agent overwrites the component so that it displays the agent's next intended action so that the user is informed.
6. Agent reads `<canvas>/components/<component_name>/feature-requirements.md`.
7. Agent begins work.
8. Agent partially completes work and overwrites the component to show the partial output and the agent's next intended action so that the user is informed.
9. Agent continues work.
10. Agent partially completes work and overwrites the component to show the partial output and the agent's next intended action so that the user is informed.
11. Agent completes work and overwrites the component to show the final state so that the user is informed.
12. Agent creates or updates `<canvas>/components/<component_name>/feature-requirements.md` if it has learned something new about the requirements.

Do not erase or mutate unrelated components!

## Removing

1. Prompt arrives indicating the desire to remove or delete one or many components.
2. Agent removes component path from `<canvas>/input.json`.
3. Agent deletes component at `<canvas>/components/<component_name>/` (skip this if user asked to hide component).
4. Agent responds as done.

## Prompt Callbacks

For functionality that would benefit from the dynamism or intelligence of an agent, or if the building of something can be deferred until interacted with use Prompt Callbacks.

`<liquidos-callback>`
Custom HTML element used to declare an agent callback action

`prompt`
The action performed and/or the user's intent

`values` 
Required when `prompt` uses placeholders. 
It should be a comma-separated allowlist of field names the callback can read.

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
