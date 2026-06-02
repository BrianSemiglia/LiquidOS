---
name: share-app
description: Package a canvas and its components' requirements into a portable folder bundle for sharing
triggers:
  - User asks to share a canvas
  - User asks to share an app
  - User asks to export a canvas
  - User wants to send a workspace's canvas to someone else
---

# Share App

Use this skill when the user wants to share a canvas — either to send to someone else, save for later, or copy to another workspace.

The output is a **plain-folder bundle of requirements only**. No code, no view.html, no state, no view.json — just the canvas's `canvas-requirements.txt` and each component's `feature-requirements.txt`. The receiving instance reads the requirements and builds a fresh implementation locally; nothing executes on import.

## What a bundle looks like

```text
<canvas-name>/
  canvas-requirements.txt
  components/
    <component-name>/
      feature-requirements.txt
    <component-name>/
      feature-requirements.txt
```

That's the entire format. No JSON, no manifest, no signatures (yet). The folder structure mirrors the workspace structure, so an `import-app` skill (when it exists) can place it back into a workspace by copying.

## When to use

- The user says "share this canvas," "export this app," "save this as a bundle," "send me the requirements for this canvas," or similar.
- The user has finished building something they want a copy of without keeping the workspace around.
- A future networking skill needs an artifact to ship.

## What to do

Run the export script:

```bash
bash skills/share-app/scripts/export.sh <canvas-name> <workspace.liquidos> [output-dir]
```

- `canvas-name` is the name of the canvas inside the workspace (e.g., `gadgets`).
- `workspace.liquidos` is the workspace folder.
- `output-dir` is optional; defaults to the current working directory. The bundle is created inside `output-dir` as a subfolder named after the canvas.

The script:

1. Reads `<workspace>/<canvas>/canvas-requirements.txt`. If it's empty or missing, the bundle still includes the file (empty) so the receiver knows a canvas-level description was intentionally not provided.
2. Reads `<workspace>/<canvas>/input.json` to find the component list.
3. For each component listed, reads `<workspace>/<canvas>/<component-path>/presented/feature-requirements.txt` and copies it to `<output-dir>/<canvas-name>/components/<component-leaf>/feature-requirements.txt`.
4. Prints a one-line JSON summary of what was written (canvas name, output path, components included).

## What NOT to include

- `canvas.js`, `input.json`, `output.json`, `state.json` — these are implementation, not intent.
- `view.json`, `view.html`, `functions.js`, `services/`, `data/`, `diagnostics/` — also implementation.
- Component scaffolding files (`.gitkeep`, etc.).

The receiving instance's agent reads the requirements and builds the implementation from scratch. That's the whole point of sharing intent rather than code.

## Reviewing before sending

Before handing the bundle to anyone, read each file in the output and confirm:
- `canvas-requirements.txt` describes only the canvas's behavior, not what's on it.
- Each `feature-requirements.txt` describes only that component's behavior, in plain language, no implementation details.
- Nothing personal or sensitive is in any of the requirement files.

If anything is off, edit the source file in the workspace (which updates the next export) rather than editing the bundle.
