---
name: canvas-instance-creator
description: Create a new live canvas instance with proper directory structure and files
triggers:
  - User asks to create a new canvas instance
  - User wants to set up a new live canvas
  - User mentions creating a canvas
---

# Canvas Instance Creator

Scaffold a new live canvas instance with the correct directory structure, JSON manifests, and HTML page.

## Convention: Follow the Established Pattern

**Important**: When setting up a new canvas, follow the exact convention of existing instances. Don't reinvent the wheel.

The established pattern (seen in `to-the-metal-hairscut`):
- `canvas.html` is created inside the instance directory by the script
- `canvas.html` is then **copied to project root as `index.html`** so the canvas is accessible at `http://localhost:xxxx/` (not `http://localhost:xxxx/canvas.html`)
- The server serves `index.html` from the project root automatically

**Common mistake**: Trying to serve `canvas.html` directly or creating new HTML files at root with different names. Just copy `canvas.html` to `index.html` at root.

## Core Principle

**Never modify source data when creating interfaces.**

When building canvas components that reference source files (MP3s, PDFs, apps, images, etc.), only create interface components that *reference* the original data. Do not:
- Rename, move, or delete original source files
- Modify file contents (audio, PDF, app binaries, etc.)
- Re-encode or transform source data unless explicitly asked

Create component JSONs that point to the original files in their current location. The interface should be a view layer only — the source data remains untouched.

## Loading-First Updates

When creating or updating a component instance, the very first visible response should be a loading-state version of the same large component shell.

Keep the component in place while the update is in progress. Do not replace it with a smaller placeholder or remove it from the canvas. After the loading state is shown, complete the work and then swap in the success, error, or final result state.

This applies to add and update flows where the user is waiting for a component to be produced or changed.

## Quick Start

Use the creation script (run from your project root where `server.js` lives):

```bash
bash ~/.hermes/skills/canvas-instance-creator/scripts/create-instance.sh <instance-name>
```

This creates `canvases/<instance-name>/` with:
- `input.json` — component manifest (starts empty)
- `output.json` — prompt queue (starts empty)
- `components/` — directory for component JSON files
- `canvas.html` — the live canvas page (copied from template)

**After running the script**, copy canvas.html to index.html at project root:
```bash
cp canvases/<instance-name>/canvas.html /path/to/project/index.html
```

**Note**: The script automatically copies `canvas.html` to `index.html` at the project root (if not already present) so the canvas is accessible at `http://localhost:PORT/` following the established convention.

**Important convention**: The server serves `index.html` from the project root. To make your canvas accessible at `http://localhost:xxxx/` (without path), copy your instance's `canvas.html` to `index.html` at the project root:

```bash
cp canvases/<instance-name>/canvas.html index.html
```

## Starting the Server

After creating the instance, start the server pointing at your new instance:

```bash
node server.js --input canvases/<instance-name>/input.json --output canvases/<instance-name>/output.json --port 3000
```

Open `http://localhost:3000/canvas.html` in your browser.

## Adding Components

1. Create component JSON files in `components/` directory (mirror the source file path under `components/`)
2. Update `input.json` to include the component JSON paths
3. The page auto-reloads via SSE when files change

See `live-canvas-server` skill for full documentation on component structure and workflows.

## File Paths Convention

Component JSON files live inside the instance `components/` directory and mirror the absolute path of the represented source file:

```
components~/Documents/Music/to the metal/song.mp3.component.json
```

The component JSON's `file` field points to the actual source file:

```json
{
  "file": "~/Documents/Music/to the metal/song.mp3",
  "type": "audio/mpeg",
  "html": "<audio controls data-input-file></audio>"
}
```

Then `input.json` references the component JSON by its absolute path inside the instance:

```json
{
  "components": [
    "/absolute/path/to/canvases/instance/components~/Documents/Music/to the metal/song.mp3.component.json"
  ]
}
```

## Script Reference

The `scripts/create-instance.sh` script:
- Creates `canvases/<instance-name>/` directory structure
- Initializes `input.json` with empty components array
- Initializes `output.json` as empty array
- Copies `canvas.html` from live-canvas-server template
- Searches for `server.js` in current directory or parents to determine project root

## References

- `references/audio-interlace-technique.md` — ffmpeg technique for interlacing two audio tracks (alternating every N seconds)
