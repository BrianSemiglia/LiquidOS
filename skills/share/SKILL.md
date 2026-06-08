---
name: share
description: Make a canvas discoverable to other peers, or install one someone else shared
triggers:
  - User asks to share, publish, or unshare a canvas
  - User asks to install or import a shared bundle
  - User asks to exclude a component from a shared canvas
---

# Share

Sharing a canvas makes it discoverable to peers. The shared form is a **bundle**: a plain folder containing the canvas's `feature-requirements.txt` and each shared component's `feature-requirements.txt`. The receiver reads the requirements and rebuilds the implementation locally — nothing in a bundle executes.

## Share

```bash
bash skills/share/scripts/share.sh <workspace.liquidos> <canvas-name>
```

One shot. Copies the requirements files into `<workspace>/.share/published/<canvas>/`, regenerates the local feed, and sets the canvas's `share.json` to `{ "shared": true }`. Peers see it next time they pull this peer's feed.

Republishing (calling `share.sh` again on a canvas that's already shared) overwrites the previous version with updated content.

## Unshare

```bash
bash skills/share/scripts/unshare.sh <workspace.liquidos> <canvas-name>
```

Removes the bundle from `.share/`, takes it out of the feed, and sets `share.json` to `{ "shared": false }`. Tolerant of pieces being missing (e.g., if the canvas was never shared, it still flips the flag off and exits cleanly).

## Install

```bash
bash skills/share/scripts/install.sh <bundle-dir> <workspace.liquidos> [canvas-name]
```

Lays a bundle down as a new canvas in the workspace. Errors if the canvas name is taken — pass `[canvas-name]` to install under a different name. After install:

- Each component shows a `Loading…` placeholder. Build the implementations following the [component skill](../component/SKILL.md).
- If the canvas's requirements describe a non-stack presentation (3D, grid, etc.), rewrite `canvas.js` per the [canvas skill](../canvas/SKILL.md).

## Excluding a component from a shared canvas

Sharing happens at canvas scope — a component can't be shared standalone. What you *can* do is exclude an individual component from a shared canvas by writing an opt-out flag:

```bash
echo '{ "shared": false }' > <workspace>/<canvas>/components/<name>/share.json
```

The canvas still appears in the feed; that one component is dropped from the bundle. This only takes effect while the canvas is shared — opting out a component on an unshared canvas has no observable effect.

## Review the bundle first

Before sharing, read the requirements files in the canvas and confirm:

- `feature-requirements.txt` describes behavior, not implementation.
- Each component's `feature-requirements.txt` is plain language and faithful to the component.
- Nothing personal or sensitive is in any file.

If something needs fixing, edit the source file in the workspace — the next `share.sh` call picks it up.

## Safety

Bundles are intent only — no JavaScript, no scripts, no services. Nothing executes on install. The only thing that runs is the agent itself when it reads the requirements and writes the implementations, under the user's review like any other agent work.
