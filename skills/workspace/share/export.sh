#!/bin/bash
set -euo pipefail

CANVAS_NAME="${1:-}"
WORKSPACE_DIR="${2:-${LIQUIDOS_WORKSPACE:-}}"
OUTPUT_DIR="${3:-$(pwd)}"

if [ -z "$CANVAS_NAME" ] || [ -z "$WORKSPACE_DIR" ]; then
    echo "Usage: $0 <canvas-name> <workspace.liquidos> [output-dir]" >&2
    echo "" >&2
    echo "Packages a canvas's requirements (canvas-level + each component's)" >&2
    echo "into a portable folder bundle. No code, no state, no view files." >&2
    echo "Default output-dir is the current working directory." >&2
    exit 1
fi

if [ ! -d "$WORKSPACE_DIR" ]; then
    echo "Error: workspace does not exist: $WORKSPACE_DIR" >&2
    exit 1
fi

WORKSPACE_DIR="$(cd "$WORKSPACE_DIR" && pwd)"

case "$WORKSPACE_DIR" in
    *.liquidos) ;;
    *)
        echo "Error: workspace must be a .liquidos folder: $WORKSPACE_DIR" >&2
        exit 1
        ;;
esac

CANVAS_DIR="$WORKSPACE_DIR/$CANVAS_NAME"

if [ ! -d "$CANVAS_DIR" ]; then
    echo "Error: canvas does not exist: $CANVAS_DIR" >&2
    exit 1
fi

INPUT_PATH="$CANVAS_DIR/input.json"

if [ ! -f "$INPUT_PATH" ]; then
    echo "Error: canvas has no input.json: $INPUT_PATH" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
BUNDLE_DIR="$OUTPUT_DIR/$CANVAS_NAME"

if [ -e "$BUNDLE_DIR" ]; then
    echo "Error: bundle path already exists: $BUNDLE_DIR" >&2
    echo "Remove or rename it before re-exporting." >&2
    exit 1
fi

mkdir -p "$BUNDLE_DIR/components"

# Canvas-level requirements: always include the file in the bundle, even
# if empty, so the receiver knows whether the source had a description.
# canvas-subtitle.txt and canvas-tags.txt are NOT copied here — those
# are feed metadata and the agent generates them after export, by
# reading the bundle's requirements and writing fresh subtitle.txt and
# tags.txt into the bundle directory. Keeping them out of the canvas
# itself keeps source clutter down for canvases that nobody ever
# shares.
CANVAS_REQ_SRC="$CANVAS_DIR/feature-requirements.txt"
CANVAS_REQ_DEST="$BUNDLE_DIR/feature-requirements.txt"
if [ -f "$CANVAS_REQ_SRC" ]; then
    cp "$CANVAS_REQ_SRC" "$CANVAS_REQ_DEST"
else
    : > "$CANVAS_REQ_DEST"
fi

# Component requirements: walk input.json.components, copy each
# component's presented/feature-requirements.txt under its leaf name.
INCLUDED_NAMES=()
MISSING_NAMES=()

# Parse input.json.components into a list of canvas-relative paths via
# node. Bash is the wrong shape for JSON; node ships with the runtime.
# Use a while-read loop instead of mapfile so we work on stock macOS
# bash (3.2).
COMPONENT_PATHS=()
while IFS= read -r line; do
    [ -n "$line" ] && COMPONENT_PATHS+=("$line")
done < <(node -e '
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const components = Array.isArray(input.components) ? input.components : [];
for (const c of components) {
    if (typeof c === "string") process.stdout.write(c + "\n");
}
' "$INPUT_PATH")

for COMPONENT_REL in "${COMPONENT_PATHS[@]+"${COMPONENT_PATHS[@]}"}"; do
    # Component leaf name (last path segment) is what we use in the bundle.
    COMPONENT_LEAF="$(basename "$COMPONENT_REL")"
    COMPONENT_REQ_SRC="$CANVAS_DIR/$COMPONENT_REL/presented/feature-requirements.txt"
    COMPONENT_REQ_DEST="$BUNDLE_DIR/components/$COMPONENT_LEAF/feature-requirements.txt"
    mkdir -p "$BUNDLE_DIR/components/$COMPONENT_LEAF"
    if [ -f "$COMPONENT_REQ_SRC" ]; then
        cp "$COMPONENT_REQ_SRC" "$COMPONENT_REQ_DEST"
        INCLUDED_NAMES+=("$COMPONENT_LEAF")
    else
        : > "$COMPONENT_REQ_DEST"
        MISSING_NAMES+=("$COMPONENT_LEAF")
    fi
done

# JSON summary on stdout — single line for easy parsing by the agent.
node -e '
const path = process.argv[1];
const canvas = process.argv[2];
const includedRaw = process.argv[3];
const missingRaw = process.argv[4];
const included = includedRaw ? includedRaw.split(" ") : [];
const missing = missingRaw ? missingRaw.split(" ") : [];
process.stdout.write(JSON.stringify({
    bundle: path,
    canvas,
    components: { included, missingRequirements: missing }
}) + "\n");
' "$BUNDLE_DIR" "$CANVAS_NAME" "${INCLUDED_NAMES[*]:-}" "${MISSING_NAMES[*]:-}"
