---
name: workspace
description: Workspace-scope work — switching the active canvas, listing/creating/renaming/deleting canvases, and sharing canvases between workspaces
triggers:
  - User wants to switch the active canvas
  - User wants to create, rename, or delete a canvas
  - User asks what canvases exist
  - User wants to share, export, or publish a canvas
  - User wants to import or install a shared bundle
  - User wants to toggle sharing on or off
---

# Workspace

A LiquidOS workspace is a folder whose name ends in `.liquidos`. It holds one or more canvases as direct children, a pointer file naming the active canvas, and an opt-in `.share/` subtree for distribution.

Workspace files are the source of truth: the harness watches them, and writes from the agent or the HTTP endpoints converge — edit the file, the harness sees it.

## Anatomy

```text
Workspace.liquidos/
  active-canvas.json          — { "canvas": "<canvas-name>" }
  <canvas-name>/              — a canvas folder (see ../canvas/SKILL.md)
  <other-canvas>/
  .share/                     — sharing tree (appears once a bundle is published)
    feed.json
    published/<name>/
    bundles/<hash>.tar
  .liquidos/                  — harness scratch (logs, errors); don't edit
```

A canvas is any direct child folder that contains `input.json`.

## What the agent does at workspace scope

### Switch the active canvas

```bash
echo '{ "canvas": "<canvas-name>" }' > <workspace>/active-canvas.json
```

The harness sees the change, validates the canvas exists, tears down the previous canvas runtime, starts the new one, and tells the client to reload. If the named canvas doesn't exist, the file is treated as invalid and active stays where it was.

Equivalent HTTP: `POST /canvas` with `{ "name": "<canvas-name>" }`.

### List canvases

Scan the workspace for direct child folders that contain `input.json`. Each one is a canvas.

### Create a new canvas

```bash
bash skills/canvas/scripts/create-instance.sh <canvas-name> <workspace.liquidos>
```

Lays down the canvas folder structure (see `../canvas/SKILL.md`). Does **not** make the new canvas active — write `active-canvas.json` separately if that's what the user wants.

### Rename a canvas

Rename the folder. If the renamed canvas is currently active, also rewrite `active-canvas.json` with the new name to avoid a startup error on the next boot.

### Delete a canvas

Destructive — confirm with the user first. Then:

1. If the canvas is currently active, write `active-canvas.json` to point at a remaining canvas.
2. Remove `<workspace>/<canvas-name>/`.

### Toggle sharing of a canvas

```bash
echo '{ "shared": true }' > <workspace>/<canvas-name>/share.json
```

`{ "shared": false }` opts out. The network protocol handlers filter the feed by this flag; a canvas's bundle is only visible to peers when its `share.json` says `shared: true`. Components can opt out individually via `<canvas>/components/<name>/share.json`.

## Sharing

Sharing exports a canvas as a portable **bundle** — a plain folder containing only the canvas's `feature-requirements.txt` and each component's `feature-requirements.txt`. No code, no view.html, no state. The receiving instance reads the requirements and builds a fresh implementation locally; nothing executes on import.

### Bundle shape

```text
<canvas-name>/
  feature-requirements.txt    — canvas behavior (copied from the source)
  canvas-subtitle.txt         — one-line pitch for feeds (written by agent after export)
  canvas-tags.txt             — one tag per line for feed filtering (written by agent after export)
  components/
    <component-name>/
      feature-requirements.txt
```

The folder mirrors the workspace structure so import can place it back by copying. `canvas-subtitle.txt` and `canvas-tags.txt` live in the bundle only, not in the source canvas — the agent writes them after `export.sh` runs.

### Export

```bash
bash skills/workspace/share/export.sh <canvas-name> <workspace.liquidos> [output-dir]
```

Reads `<workspace>/<canvas>/feature-requirements.txt` and each component's `presented/feature-requirements.txt`; writes them into `<output-dir>/<canvas-name>/`. `output-dir` defaults to the current working directory.

Deliberately excluded: `canvas.js`, `input.json`, `state.json`, `view.*`, `functions.js`, `services/`, `data/`, `diagnostics/`. Implementation is rebuilt fresh on import.

### Subtitle and tags

After `export.sh` runs, the agent writes the two feed-metadata files by reading the bundle's requirements:

- **canvas-subtitle.txt** — one line, 6–12 words. What the canvas is for, said in one breath.
- **canvas-tags.txt** — one lowercase hyphenated tag per line, 3–8 tags. Used for feed filtering.

```bash
echo "A 3D diorama of small tools and ambient widgets" \
  > <bundle>/canvas-subtitle.txt
printf '3d\nspatial\ntools\nwidgets\n' \
  > <bundle>/canvas-tags.txt
```

### Reviewing before sending

Read each file in the bundle and confirm:
- `feature-requirements.txt` describes behavior only, not implementation.
- Each component's `feature-requirements.txt` is plain language and faithful to the component.
- Nothing personal or sensitive is in any file.

If something needs fixing, edit the source file in the workspace (so the next export is correct) rather than the bundle.

### Import

```bash
bash skills/workspace/share/import.sh <bundle-dir> <workspace.liquidos> [canvas-name]
```

Validates the bundle, creates the canvas (errors if the name is taken — pass `[canvas-name]` to import under a different name), copies `feature-requirements.txt`, scaffolds each component, and overwrites the scaffolded `feature-requirements.txt` with the bundle's.

After import, each component shows a `Loading…` placeholder. Build the implementations following `../component/SKILL.md`. If the canvas's requirements describe a non-stack presentation (3D, grid, etc.), rewrite `canvas.js` to match.

### Feed

```bash
bash skills/workspace/share/feed.sh <bundles-dir> [output-path]
```

Walks every immediate subdirectory of `<bundles-dir>` that looks like a bundle and emits per-bundle metadata: name, subtitle, tags, full requirements text, components, sha256 hash, size, createdAt. The harness serves this at `/share/feed` once the network layer is up.

### Publish

```bash
bash skills/workspace/share/publish.sh <bundle-dir> <workspace.liquidos>
```

Validates the bundle (needs `feature-requirements.txt`, non-empty `canvas-subtitle.txt`, non-empty `canvas-tags.txt`), copies it into `<workspace>/.share/published/<name>/`, writes the content-addressed TAR to `<workspace>/.share/bundles/<hash>.tar`, and regenerates `<workspace>/.share/feed.json`.

### Three independent states

A bundle on disk doesn't have to be published, and a published bundle doesn't have to be shared:

- **exists** — the bundle folder exists somewhere on disk.
- **published** — installed into `<workspace>/.share/` so the peer's libp2p node can serve it.
- **shared** — `<canvas>/share.json` says `{ "shared": true }`, so peers actually see it in the feed.

## Safety

Bundles are intent only — no JavaScript, no scripts, no services. Nothing executes on import. The only thing that runs is the agent itself when it reads the requirements and writes implementations, which the user reviews like any other agent work.
