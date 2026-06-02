#!/bin/bash
set -euo pipefail

BUNDLE_DIR="${1:-}"
WORKSPACE_DIR="${2:-${LIQUIDOS_WORKSPACE:-}}"
CANVAS_NAME_OVERRIDE="${3:-}"

if [ -z "$BUNDLE_DIR" ] || [ -z "$WORKSPACE_DIR" ]; then
    echo "Usage: $0 <bundle-dir> <workspace.liquidos> [canvas-name]" >&2
    echo "" >&2
    echo "Imports a requirements bundle (the output of export.sh) into the" >&2
    echo "workspace as a NEW canvas. Components are scaffolded with the same" >&2
    echo "shape any new component gets (presented/, services/, etc.) but with" >&2
    echo "the bundle's feature-requirements.txt copied into place. The agent" >&2
    echo "then reads each component's requirements and builds the actual" >&2
    echo "implementation." >&2
    echo "" >&2
    echo "The canvas takes the bundle folder's name by default; pass a third" >&2
    echo "argument to import under a different name." >&2
    exit 1
fi

if [ ! -d "$BUNDLE_DIR" ]; then
    echo "Error: bundle does not exist: $BUNDLE_DIR" >&2
    exit 1
fi

BUNDLE_DIR="$(cd "$BUNDLE_DIR" && pwd)"

if [ ! -f "$BUNDLE_DIR/canvas-requirements.txt" ]; then
    echo "Error: not a valid bundle (missing canvas-requirements.txt): $BUNDLE_DIR" >&2
    exit 1
fi

if [ ! -d "$BUNDLE_DIR/components" ]; then
    echo "Error: not a valid bundle (missing components/ directory): $BUNDLE_DIR" >&2
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

# Resolve canvas name. The override wins; otherwise use the bundle folder's
# basename. create-instance.sh sanitizes (lowercase, hyphenated), so we
# don't need to repeat that here.
if [ -n "$CANVAS_NAME_OVERRIDE" ]; then
    CANVAS_NAME="$CANVAS_NAME_OVERRIDE"
else
    CANVAS_NAME="$(basename "$BUNDLE_DIR")"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CREATE_INSTANCE="$REPO_ROOT/skills/canvas-creator/scripts/create-instance.sh"
CREATE_COMPONENT="$REPO_ROOT/skills/component-creator/scripts/create-component.sh"

if [ ! -f "$CREATE_INSTANCE" ]; then
    echo "Error: missing canvas-creator script: $CREATE_INSTANCE" >&2
    exit 1
fi

if [ ! -f "$CREATE_COMPONENT" ]; then
    echo "Error: missing component-creator script: $CREATE_COMPONENT" >&2
    exit 1
fi

# Create the canvas. create-instance.sh errors if it already exists; that
# error path is what we want — the import shouldn't silently merge into a
# canvas the user may be using.
# create-instance.sh prints two informational lines on stdout before
# the JSON summary, so grab only the last non-empty line for parsing.
CREATE_OUTPUT="$(bash "$CREATE_INSTANCE" "$CANVAS_NAME" "$WORKSPACE_DIR")"
CREATE_JSON="$(printf '%s' "$CREATE_OUTPUT" | awk 'NF { last = $0 } END { print last }')"
CANVAS_PATH="$(printf '%s' "$CREATE_JSON" | node -e '
let buf = "";
process.stdin.on("data", c => buf += c);
process.stdin.on("end", () => {
    try { process.stdout.write(JSON.parse(buf).path); }
    catch { process.exit(1); }
});
')"

if [ -z "$CANVAS_PATH" ] || [ ! -d "$CANVAS_PATH" ]; then
    echo "Error: canvas creation did not return a usable path" >&2
    exit 1
fi

# Replace the empty canvas-requirements.txt with the bundle's version.
cp "$BUNDLE_DIR/canvas-requirements.txt" "$CANVAS_PATH/canvas-requirements.txt"

CREATED_NAMES=()
SKIPPED_NAMES=()

# Walk the bundle's components directory. Each subfolder is one component;
# we scaffold it via create-component.sh, then overwrite its
# feature-requirements.txt with the bundle's.
for COMPONENT_PATH in "$BUNDLE_DIR/components"/*/; do
    [ -d "$COMPONENT_PATH" ] || continue
    COMPONENT_NAME="$(basename "$COMPONENT_PATH")"
    REQ_SRC="$COMPONENT_PATH/feature-requirements.txt"

    # Try to scaffold. If create-component.sh fails (component already
    # exists in the freshly-made canvas — shouldn't happen, but be
    # defensive), record it and move on rather than aborting the whole
    # import.
    if bash "$CREATE_COMPONENT" "$CANVAS_PATH" "$COMPONENT_NAME" >/dev/null 2>&1; then
        if [ -f "$REQ_SRC" ]; then
            cp "$REQ_SRC" "$CANVAS_PATH/components/$COMPONENT_NAME/presented/feature-requirements.txt"
        fi
        CREATED_NAMES+=("$COMPONENT_NAME")
    else
        SKIPPED_NAMES+=("$COMPONENT_NAME")
    fi
done

node -e '
const canvas = process.argv[1];
const canvasPath = process.argv[2];
const createdRaw = process.argv[3];
const skippedRaw = process.argv[4];
const created = createdRaw ? createdRaw.split(" ") : [];
const skipped = skippedRaw ? skippedRaw.split(" ") : [];
process.stdout.write(JSON.stringify({
    canvas, canvasPath,
    components: { created, skipped }
}) + "\n");
' "$CANVAS_NAME" "$CANVAS_PATH" "${CREATED_NAMES[*]:-}" "${SKIPPED_NAMES[*]:-}"
