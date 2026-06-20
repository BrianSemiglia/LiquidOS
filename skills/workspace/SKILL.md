---
name: workspace
description: Workspace-scope work — switching the active canvas, listing/creating/renaming/deleting canvases, showing/hiding system panels (prompt bar, canvas picker, requirements editors)
triggers:
  - User wants to switch the active canvas
  - User wants to create, rename, or delete a canvas
  - User asks what canvases exist
  - User wants to hide or show the prompt bar (a clean canvas / escape mode)
  - User wants to open or close the canvas picker ("Spaces") or the all-canvases view
  - User wants to open or close the canvas requirements or a component's requirements editor
  - User wants to engage or disengage the working surface
---

# Workspace

A LiquidOS workspace is a folder whose name ends in `.liquidos`. It holds one or more canvases as direct children, a single `ui-state.json` that names the active canvas and which system panels are open, and an opt-in `.share/` subtree for distribution.

Workspace files are the source of truth: the harness watches them, and writes from the agent or the HTTP endpoints converge — edit the file, the harness sees it.

## Anatomy

```text
Workspace.liquidos/
  ui-state.json               — active canvas + which system panels are open (optional; absent = home, nothing open)
  <canvas-name>/              — a canvas folder (see ../canvas/SKILL.md)
  <other-canvas>/
  .share/                     — sharing tree (appears once a bundle is published)
    feed.json
    published/<name>/
  .liquidos/                  — harness scratch (logs, errors); don't edit
```

A canvas is any direct child folder that contains `index.json`.

## What the agent does at workspace scope

### Switch the active canvas

```bash
bash skills/workspace/scripts/set-ui-state.sh <workspace> --canvas <canvas-name>
```

The active canvas is a key in `ui-state.json`; the tool read-merge-writes it so the panel state is left alone. The harness watches the file, validates the canvas exists, tears down the previous canvas runtime, starts the new one, and tells the client to reload. If the named canvas doesn't exist, the change is ignored and active stays where it was. There is no dedicated endpoint — this goes through the generic `PUT /workspace/ui-state.json` path like every other workspace write.

### Show/hide system panels (escape mode, canvas picker, requirements editors)

The surface is either **engaged** (normal) or **disengaged** into one of three mutually exclusive surfaces, with a component's requirements editor as an independent layer on top:

- `--engaged` — normal: prompt bar up, nothing stepped back
- `--disengaged prompt` — escape mode: the prompt bar hidden for a clean canvas
- `--disengaged canvasPicker` — the "Spaces" grid of all canvases
- `--disengaged canvasRequirements` — the active canvas's requirements editor
- `--component <scope>` / `--no-component` — independent of the surface: open/close one component's requirements editor, by its scope

Drive it with the tool — it merges the two axes, so changing the surface leaves an open component alone and vice versa:

```bash
bash skills/workspace/scripts/set-ui-state.sh <workspace> --disengaged prompt            # clean canvas
bash skills/workspace/scripts/set-ui-state.sh <workspace> --disengaged canvasPicker      # open the Spaces picker
bash skills/workspace/scripts/set-ui-state.sh <workspace> --disengaged canvasRequirements
bash skills/workspace/scripts/set-ui-state.sh <workspace> --component <scope>            # open a component's requirements
bash skills/workspace/scripts/set-ui-state.sh <workspace> --no-component                 # close it
bash skills/workspace/scripts/set-ui-state.sh <workspace> --engaged --no-component       # back to normal
```

`<scope>` is the component's folder path — the same scope string used for agent jobs. The harness watches the resulting `ui-state.json` and every open client applies the new state live.

### List canvases

Scan the workspace for direct child folders that contain `index.json`. Each one is a canvas.

### Create a new canvas

```bash
bash skills/canvas/scripts/create-instance.sh <canvas-name> <workspace.liquidos>
```

Lays down the canvas folder structure (see `../canvas/SKILL.md`). Does **not** make the new canvas active — run `set-ui-state.sh <workspace> --canvas <name>` separately if that's what the user wants.

### Rename a canvas

Rename the folder. If the renamed canvas is currently active, also switch to the new name (`set-ui-state.sh <workspace> --canvas <new-name>`) to avoid a startup fallback to home on the next boot.

### Delete a canvas

Destructive — confirm with the user first. Then:

1. If the canvas is currently active, switch to a remaining canvas (`set-ui-state.sh <workspace> --canvas <other-name>`).
2. Remove `<workspace>/<canvas-name>/`.

### Share a canvas

Share, unshare, or install a shared bundle — see [`../sharing/SKILL.md`](../sharing/SKILL.md).
