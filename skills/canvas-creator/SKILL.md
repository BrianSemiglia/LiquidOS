---
name: canvas-creator
description: Create a new LiquidOS canvas workspace with the current directory structure
triggers:
  - User asks to create a new canvas instance
  - User wants to set up a new live canvas
  - User mentions creating a canvas
---

# Canvas Instance Creator

Use this skill when the user asks to create a new canvas/workspace.

## Current Shape

A canvas contains:

```text
<input canvas>/
  input.json
  output.json
  components/
  layouts/
  transitions/
```

`input.json` is the component manifest. `components/` contains component folders. See `./component-creator/SKILL.md` for component structure.

## Quick Start

Run from the AgentRuntime directory:

```bash
bash canvas-creator/scripts/create-instance.sh <instance-name>
```

This creates:

```text
canvases/<instance-name>/input.json
canvases/<instance-name>/output.json
canvases/<instance-name>/components/
canvases/<instance-name>/layouts/
canvases/<instance-name>/transitions/
```

## Core Principle

Never modify source data when creating interfaces.

When building canvas components that reference source files, create interface components that reference or serve the originals without renaming, moving, deleting, or rewriting the source files unless the user explicitly asks.

## Loading-First Updates

When creating or updating a component instance, the first visible response should be a loading-state version of the relevant component. Keep it in place while work continues.

## Adding Components

1. Create a component folder under `components/`.
2. Ensure the component includes `feature-requirements.md` and `view.json`.
3. Add the component folder path to `input.json` if it is not already present.
4. Preserve existing `input.json` keys and component paths.

## Starting the App

Use the app/server workflow provided by the LiquidOS runtime. Do not create or copy HTML entry files for the canvas.
