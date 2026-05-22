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
    rm -f "$CANVAS_DIR/canvas.html"
fi

for name in layouts transitions; do
    if [ -d "$SCRIPT_DIR/../$name" ]; then
        mkdir -p "$CANVAS_DIR/$name"
        cp -R "$SCRIPT_DIR/../$name/." "$CANVAS_DIR/$name/"
    else
        mkdir -p "$CANVAS_DIR/$name"
    fi
done

mkdir -p "$CANVAS_DIR/components"

if [ ! -f "$CANVAS_DIR/input.json" ]; then
    cat > "$CANVAS_DIR/input.json" <<'JSON'
{
  "components": [],
  "layoutPath": "layouts/stack.json",
  "transitionPath": "transitions/soft.json",
  "css": "body{background:#0b1120}"
}
JSON
fi

node -e '
const fs = require("fs");
const inputPath = process.argv[1];
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
if (!Array.isArray(input.components)) input.components = [];
if (typeof input.layoutPath !== "string" || !input.layoutPath.trim()) input.layoutPath = "layouts/stack.json";
if (typeof input.transitionPath !== "string" || !input.transitionPath.trim()) input.transitionPath = "transitions/soft.json";
fs.writeFileSync(inputPath, JSON.stringify(input, null, 2) + "\n");
' "$CANVAS_DIR/input.json"

if [ ! -f "$CANVAS_DIR/output.json" ]; then
    printf '[]\n' > "$CANVAS_DIR/output.json"
fi

printf '{"canvas":"%s","path":"%s"}\n' "$SAFE_NAME" "$CANVAS_DIR"
