---
name: canvas-creator
description: Create a new LiquidOS canvas inside an existing .liquidos workspace
triggers:
  - User asks to create a new canvas instance
  - User wants to set up a new live canvas
  - User mentions creating a canvas
---

# Canvas Creator

Use this skill when the user asks to create a new canvas inside an existing `.liquidos` workspace.

Read `../workspace-model.md` before creating canvases.

## Current Shape

The `.liquidos` folder is the workspace root and the canvas root. A canvas is a direct child of that folder:

```text
Workspace.liquidos/
  selected-canvas.json
  home/
    input.json
    output.json
    components/
    layouts/
    transitions/
  <canvas-name>/
    input.json
    output.json
    components/
    layouts/
    transitions/
```

`input.json` is the component manifest. `components/` contains component folders. See `../component-creator/SKILL.md` for component structure.

## Quick Start

Run from the AgentRuntime directory:

```bash
bash skills/canvas-creator/scripts/create-instance.sh <canvas-name> /path/to/Workspace.liquidos
```

This creates:

```text
Workspace.liquidos/<canvas-name>/input.json
Workspace.liquidos/<canvas-name>/output.json
Workspace.liquidos/<canvas-name>/components/
Workspace.liquidos/<canvas-name>/layouts/
Workspace.liquidos/<canvas-name>/transitions/
```

## Core Principle

Never modify source data when creating interfaces.

When building canvas components that reference source files, create interface components that reference or serve the originals without renaming, moving, deleting, or rewriting the source files unless the user explicitly asks.

## Loading-First Updates

When creating or updating a component instance, the first visible response should be a loading-state version of the relevant component. Keep it in place while work continues.

## Adding Components

1. Create a component folder under `components/`.
2. Ensure the component includes `feature-requirements.md` and `view.json`.
   `feature-requirements.md` is user-facing. Keep it plain-language, concise, and faithful to the component.
3. Add the component folder path to `input.json` if it is not already present.
4. Preserve existing `input.json` keys and component paths.

## Starting the App

Use the app/server workflow provided by the LiquidOS runtime. Do not create or copy HTML entry files for the canvas.
