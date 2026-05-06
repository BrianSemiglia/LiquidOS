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

The prompt bar can switch canvases, create a new canvas, send canvas-scoped prompts, and undo/redo JSON Patch deltas.
