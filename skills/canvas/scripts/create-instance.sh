#!/bin/bash
set -euo pipefail

CANVAS_NAME="${1:-}"
WORKSPACE_DIR="${2:-${LIQUIDOS_WORKSPACE:-}}"

if [ -z "$CANVAS_NAME" ] || [ -z "$WORKSPACE_DIR" ]; then
    echo "Usage: $0 <canvas-name> <workspace.liquidos>"
    echo ""
    echo "Creates a canvas as a direct child of the .liquidos workspace."
    echo "You may also provide LIQUIDOS_WORKSPACE instead of the second argument."
    exit 1
fi

if [ ! -d "$WORKSPACE_DIR" ]; then
    echo "Error: workspace does not exist: $WORKSPACE_DIR"
    exit 1
fi

WORKSPACE_DIR="$(cd "$WORKSPACE_DIR" && pwd)"

case "$WORKSPACE_DIR" in
    *.liquidos) ;;
    *)
        echo "Error: workspace must be a .liquidos folder: $WORKSPACE_DIR"
        exit 1
        ;;
esac

SAFE_NAME="$(printf '%s' "$CANVAS_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"

if [ -z "$SAFE_NAME" ]; then
    echo "Error: canvas name is required."
    exit 1
fi

CANVAS_DIR="$WORKSPACE_DIR/$SAFE_NAME"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/../templates"

if [ -e "$CANVAS_DIR" ]; then
    echo "Error: canvas already exists: $CANVAS_DIR"
    exit 1
fi

echo "Workspace: $WORKSPACE_DIR"
echo "Creating canvas: $CANVAS_DIR"

mkdir -p "$CANVAS_DIR/components"

if [ -d "$TEMPLATE_DIR" ]; then
    cp -R "$TEMPLATE_DIR/." "$CANVAS_DIR/"
fi

if [ ! -f "$CANVAS_DIR/input.json" ]; then
    cat > "$CANVAS_DIR/input.json" <<'JSON'
{
  "components": []
}
JSON
fi

node -e '
const fs = require("fs");
const inputPath = process.argv[1];
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
if (!Array.isArray(input.components)) input.components = [];
delete input.presentation;
fs.writeFileSync(inputPath, JSON.stringify(input, null, 2) + "\n");
' "$CANVAS_DIR/input.json"

if [ ! -f "$CANVAS_DIR/output.json" ]; then
    printf '[]\n' > "$CANVAS_DIR/output.json"
fi

# canvas-requirements.txt is a plain-text description of what the canvas
# is for — what cards it should hold, how the user wants to feel using
# it. Optional, but the natural anchor for "share this app" and for the
# agent when generating components for the canvas.
if [ ! -f "$CANVAS_DIR/canvas-requirements.txt" ]; then
    : > "$CANVAS_DIR/canvas-requirements.txt"
fi

printf '{"canvas":"%s","path":"%s"}\n' "$SAFE_NAME" "$CANVAS_DIR"
