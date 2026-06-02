---
name: share-app
description: Export a canvas to a portable requirements bundle, or import one into the workspace as a new canvas
triggers:
  - User asks to share a canvas
  - User asks to share an app
  - User asks to export a canvas
  - User asks to import a canvas
  - User asks to install an app
  - User wants to send a workspace's canvas to someone else
  - User has a requirements bundle they want to bring in
---

# Share App

Use this skill in two directions:

- **Export**: package a canvas's requirements into a portable bundle to share with someone else.
- **Import**: take a bundle someone shared and lay it down as a new canvas in this workspace; the agent then builds the implementations from the requirements.

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

## Importing a bundle

Run the import script:

```bash
bash skills/share-app/scripts/import.sh <bundle-dir> <workspace.liquidos> [canvas-name]
```

- `bundle-dir` is the folder produced by `export.sh` (or one someone handed you with the same structure).
- `workspace.liquidos` is the workspace the new canvas will live inside.
- `canvas-name` is optional; defaults to the bundle folder's name. Pass this to import under a different name (useful if the source canvas is named `home` and you already have a `home`).

The script:

1. Validates the bundle: must have `canvas-requirements.txt` and a `components/` directory.
2. Creates a new canvas with the chosen name via `canvas-creator/scripts/create-instance.sh`. Errors if a canvas with that name already exists — pass an override name in that case.
3. Copies the bundle's `canvas-requirements.txt` into the new canvas's root.
4. For each subfolder under the bundle's `components/`, scaffolds a component via `component-creator/scripts/create-component.sh` and then overwrites the scaffolded `feature-requirements.txt` with the bundle's.
5. Prints a single-line JSON summary:

   ```json
   { "canvas": "<name>", "canvasPath": "<absolute path>",
     "components": { "created": [...], "skipped": [...] } }
   ```

### After import

The canvas exists with scaffolded components, each showing a `Loading…` placeholder. The agent should then:

- Read `canvas-requirements.txt` to understand the canvas's intent (layout, interaction, state behavior).
- For each component, read its `feature-requirements.txt` and build the implementation following the rules in `../component-creator/SKILL.md`.
- The presentation (`canvas.js`) defaults to the standard stack layout; if the imported canvas's requirements describe a different presentation (3D, grid, etc.), the agent should rewrite `canvas.js` to match.

Nothing in the bundle executes on import — every file laid down is either scaffolding from the standard create-component templates or a plain-text requirements file. All implementation is built fresh in the receiving workspace.

## Safety

Bundles are intent only. They contain no JavaScript, no shell scripts, no view.html, no service code — only `*.txt` files with natural-language descriptions. There's nothing to execute on import. The only thing that runs is the agent itself when it reads the requirements and writes the implementation, and that happens under the user's review like any other agent task.

That's the whole reason this format ships intent rather than code: the trust surface is just "is this text safe to read."
