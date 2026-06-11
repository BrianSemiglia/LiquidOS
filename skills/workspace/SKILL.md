---
name: workspace
description: Workspace-scope work — switching the active canvas, listing/creating/renaming/deleting canvases
triggers:
  - User wants to switch the active canvas
  - User wants to create, rename, or delete a canvas
  - User asks what canvases exist
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

### Share a canvas

Share, unshare, or install a shared bundle — see [`../sharing/SKILL.md`](../sharing/SKILL.md).
