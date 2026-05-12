# Live Edit

Run a canvas:

```sh
node server.js --canvas canvases/random-pdfs
```

The server expects each canvas directory to contain:

```text
input.json
output.json
deltas.json
```

The prompt bar can switch canvases, create a new canvas, and send canvas-scoped prompts. The whole `canvases/` folder is tracked as one Git repo so activity across canvases has a single timeline.

## Listening components and plugins

When a component or plugin needs to listen to an external thing, keep the shape simple:

1. Pick the source of truth.
   - For stateful UI, that is usually the component JSON itself.
   - For external signals, it may be a watcher state file or a small outbox file.

2. Decide how the listener runs.
   - If it needs to stay alive, make it a plugin hook plus a background watcher or daemon.
   - If it only needs to react once, a plain callback is enough.

3. Choose the bridge back into the canvas.
   - For this repo, `output.json` is the easiest proof-of-concept bridge because the server already watches it.
   - `deltas.json` is legacy state. Undo/redo controls have been removed. Git history is now a read-only activity timeline under `canvases/`.

4. Keep loop-safety in mind.
   - If the plugin can also trigger the same thing it is watching, suppress self-caused changes for a short window.
   - If the bridge writes back into the canvas, only emit when the canvas is idle.

5. Let the server or agent update the component, not the listener.
   - The listener should report the event and any useful args.
   - The canvas update still happens through the normal callback path.

The system-volume watcher plugin follows this pattern:

- it polls the host volume in the background
- it records changes into a small state file and an outbox
- it writes a pending job into `output.json` as a proof of concept
- the server consumes that job and hands it back to Hermes

That is usually the right split when the thing being watched is external and the canvas should stay elastic rather than hard-wired to one special case.
