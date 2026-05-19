# Live Edit

Run a canvas:

```sh
node server.js --canvas canvases/random-pdfs
```

The server expects each canvas directory to contain:

```text
input.json
output.json
```

The prompt bar can switch canvases, create a new canvas, and send canvas-scoped prompts. The whole `canvases/` folder is tracked as one Git repo so activity across canvases has a single timeline.

The live canvas root is `~/Documents/LiquidOS` in both the standalone server and the Mac app.

If you are editing the running Mac app or the standalone server, update the live `~/Documents/LiquidOS` tree.

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

## Using local files without copying them

For files that already exist on disk, serve the containing folder and reference the files with HTTP URLs.

The Mac app starts a local static server automatically at launch. Its root is:

```text
~/Documents/LiquidOS/LocalFiles
```

The app passes these to the Node server and agents:

```text
LIQUIDOS_LOCAL_FILES_ROOT
LIQUIDOS_LOCAL_FILES_URL
```

For standalone development, run the same shape manually:

```bash
cd ~/Documents/LiquidOS/LocalFiles
python3 -m http.server 8000 --bind 127.0.0.1
```

Then in a component:

```json
{
  "title": "Photo",
  "html": "<img src=\"{{ resources.photo.url }}\" style=\"max-width:100%\">",
  "resources": {
    "photo": {
      "url": "http://localhost:8000/photo.jpg",
      "mime": "image/jpeg"
    }
  }
}
```

Use `resources.*.path` only for files inside the canvas folder. Files outside the canvas folder should be served over local HTTP and referenced through `resources.*.url`.

For the Mac app, put files or symlinks in the active workspace’s `LocalFiles` folder, then use:

```json
{
  "resources": {
    "photo": {
      "url": "{{ localFiles.url }}photo.jpg",
      "mime": "image/jpeg"
    }
  }
}
```

Default standalone path: `~/Documents/LiquidOS/LocalFiles`.
Opened `.liquidos` workspace path: `<workspace>.liquidos/LocalFiles`.
