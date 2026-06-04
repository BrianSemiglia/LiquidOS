---
name: workspace
description: Workspace anatomy and sharing — what lives at the .liquidos root, how the active canvas/agent are picked, and how canvases are exported, imported, and published
triggers:
  - User asks about the workspace layout
  - User asks to share a canvas
  - User asks to share an app
  - User asks to export a canvas
  - User asks to import a canvas
  - User asks to install an app
  - User wants to send a workspace's canvas to someone else
  - User has a requirements bundle they want to bring in
---

# Workspace

A LiquidOS workspace is a folder whose name ends in `.liquidos`. It holds one or more canvases as direct children, plus a couple of pointer files at the root and an opt-in `.share/` subtree for distribution.

## Anatomy

```text
Workspace.liquidos/
  active-canvas.json          — current-canvas pointer ({ "name": "<canvas>" })
  active-agent.json           — current-agent pointer ({ "kind": "<agent>" })
  <canvas-name>/              — a canvas folder (see ../canvas/SKILL.md)
  <other-canvas>/
  .share/                     — sharing tree (only present once something is published)
    feed.json                 — manifest of bundles this peer publishes
    published/<name>/         — published bundles by name
    bundles/<hash>.tar        — content-addressed bundle tarballs
  .liquidos/                  — runtime scratch (logs, errors); not user-edited
```

### Pointer files

- `active-canvas.json` — which canvas the harness loads at startup. The server validates that the named folder exists; an invalid value is a startup error.
- `active-agent.json` — which agent runtime to spawn (claude, codex, hermes, pi). An unknown value is a startup error.

These are toggled by the UI; the agent only reads them. Don't write them directly during ordinary work.

### Canvases

Each direct child folder of the workspace is a canvas — see `../canvas/SKILL.md`. Per-canvas opt-in for sharing lives at `<canvas>/share.json` (`{ "shared": true|false }`); per-component opt-out at `<canvas>/components/<name>/share.json`.

## Sharing

Sharing exports a canvas as a portable **bundle** — a plain folder containing only the canvas's `requirements.txt` and each component's `feature-requirements.txt`. No code, no view.html, no state. The receiving instance reads the requirements and builds a fresh implementation locally; nothing executes on import.

### Bundle shape

```text
<canvas-name>/
  requirements.txt        — canvas behavior (copied from the source)
  canvas-subtitle.txt     — one-line pitch for feeds (added by agent post-export)
  canvas-tags.txt         — one tag per line for feed filtering (added by agent post-export)
  components/
    <component-name>/
      feature-requirements.txt
```

The folder mirrors the workspace structure so import can place it back by copying. `canvas-subtitle.txt` and `canvas-tags.txt` are *feed metadata* — they live in the bundle only, not in the source canvas — and the agent writes them after export.

### Export

```bash
bash skills/workspace/share/export.sh <canvas-name> <workspace.liquidos> [output-dir]
```

- `output-dir` defaults to the current working directory; the bundle is created as a subfolder named after the canvas.
- Reads `<workspace>/<canvas>/requirements.txt` (empty file if absent — the empty value is intentional).
- Reads `<workspace>/<canvas>/input.json` for the component list; copies each component's `presented/feature-requirements.txt`.
- Prints a one-line JSON summary.

What's deliberately excluded: `canvas.js`, `input.json`, `output.json`, `state.json`, `view.*`, `functions.js`, `services/`, `data/`, `diagnostics/`. Implementation is rebuilt fresh on import.

### Subtitle and tags

After `export.sh` runs, the agent writes `canvas-subtitle.txt` and `canvas-tags.txt` into the bundle by reading the requirements:

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
- `requirements.txt` describes the canvas's behavior only, not implementation.
- Each `feature-requirements.txt` describes that component's behavior in plain language.
- Nothing personal or sensitive is in any file.

If anything is off, edit the source file in the workspace (so the next export is correct) rather than the bundle.

### Import

```bash
bash skills/workspace/share/import.sh <bundle-dir> <workspace.liquidos> [canvas-name]
```

- `canvas-name` defaults to the bundle folder name; pass it to import under a different name.
- Validates the bundle (needs `requirements.txt` + `components/`).
- Creates the canvas via `canvas/scripts/create-instance.sh` (errors if the name is taken).
- Copies `requirements.txt`; scaffolds each component via `component/scripts/create-component.sh` and overwrites the scaffolded `feature-requirements.txt` with the bundle's.

After import, each component shows a `Loading…` placeholder. Build the implementations following `../component/SKILL.md`; if the canvas's requirements describe a non-stack presentation (3D, grid, etc.), rewrite `canvas.js` to match.

Nothing in a bundle executes on import — every file is either scaffolding or plain-text requirements.

### Feed

The feed is a JSON manifest listing every bundle this peer publishes, with enough metadata for others to triage before downloading.

```bash
bash skills/workspace/share/feed.sh <bundles-dir> [output-path]
```

Walks every immediate subdirectory of `<bundles-dir>` that looks like a bundle and emits per-bundle:

- `name`, `subtitle`, `tags`
- `canvasRequirements` — full `requirements.txt` text (inline for cheap browsing)
- `components` — names of component subfolders
- `hash` — `sha256-…` over the bundle's contents (sorted filenames, null-separated rel-path + bytes)
- `size`, `createdAt`

Once the network layer lands, the harness serves this JSON at `/share/feed` and bundles at `/share/bundle/<hash>`. Until then it's the local published-bundle manifest.

### Publish

`feed.sh` only writes the manifest; `publish.sh` installs a bundle into the workspace's `.share/` tree so this peer can serve it.

```bash
bash skills/workspace/share/publish.sh <bundle-dir> <workspace.liquidos>
```

1. Validates `<bundle-dir>` (needs `requirements.txt`, plus non-empty `canvas-subtitle.txt` and `canvas-tags.txt`).
2. Copies the bundle into `<workspace>/.share/published/<name>/` (overwrites on republish).
3. Computes the bundle hash and writes the TAR to `<workspace>/.share/bundles/<hash>.tar`.
4. Regenerates `<workspace>/.share/feed.json`.

### Three independent states

A bundle on disk doesn't have to be published, and a published bundle doesn't have to be shared:

- **exists** — the bundle folder exists somewhere on disk.
- **published** — installed into `<workspace>/.share/` so the peer's libp2p node can serve it.
- **shared** — `<canvas>/share.json` says `{ "shared": true }`, so peers actually see it in the feed.

Toggling via the per-canvas requirements modal flips `share.json`. The network protocol handlers in `canvas/network.mjs` enforce the opt-in filter.

## Safety

Bundles are intent only — no JavaScript, no scripts, no services. Nothing runs on import. The only thing that executes is the agent itself when it reads the requirements and writes implementations, which the user reviews like any other agent work. The trust surface is just "is this text safe to read."
