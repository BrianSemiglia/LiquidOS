#!/bin/bash
set -euo pipefail

INSTANCE_NAME="${1:-}"
CANVASES_DIR="${2:-${CANVASES_ROOT:-}}"

if [ -z "$INSTANCE_NAME" ]; then
    echo "Usage: $0 <instance-name> [canvases-root]"
    echo ""
    echo "Creates a new canvas instance."
    echo "Uses [canvases-root], CANVASES_ROOT, or the nearest ./canvases folder."
    exit 1
fi

PROJECT_ROOT=""
if [ -f "server.js" ]; then
    PROJECT_ROOT="$(pwd)"
else
    DIR="$(pwd)"
    for _ in 1 2 3 4 5; do
        if [ -f "$DIR/server.js" ]; then
            PROJECT_ROOT="$DIR"
            break
        fi
        DIR="$(dirname "$DIR")"
    done
fi

if [ -z "$CANVASES_DIR" ]; then
    if [ -n "$PROJECT_ROOT" ]; then
        CANVASES_DIR="$PROJECT_ROOT/canvases"
    elif [ -d "canvases" ]; then
        CANVASES_DIR="$(pwd)/canvases"
    else
        CANVASES_DIR="$(pwd)"
    fi
fi

SAFE_NAME="$(printf '%s' "$INSTANCE_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"

if [ -z "$SAFE_NAME" ]; then
    echo "Error: canvas name is required."
    exit 1
fi

INSTANCE_DIR="$CANVASES_DIR/$SAFE_NAME"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR=""

for CANDIDATE in \
    "$PROJECT_ROOT/templates/canvas" \
    "$SCRIPT_DIR/../templates/canvas" \
    "$HOME/.hermes/skills/canvas-instance-creator/templates/canvas"; do
    if [ -n "$CANDIDATE" ] && [ -d "$CANDIDATE" ]; then
        TEMPLATE_DIR="$CANDIDATE"
        break
    fi
done

if [ -e "$INSTANCE_DIR" ]; then
    echo "Error: canvas already exists: $INSTANCE_DIR"
    exit 1
fi

echo "Canvases root: $CANVASES_DIR"
echo "Creating canvas: $INSTANCE_DIR"

mkdir -p "$INSTANCE_DIR/components"

copy_asset_dir() {
    local name="$1"
    local source=""

    for CANDIDATE in \
        "$PROJECT_ROOT/$name" \
        "$(dirname "$CANVASES_DIR")/$name"; do
        if [ -n "$CANDIDATE" ] && [ -d "$CANDIDATE" ]; then
            source="$CANDIDATE"
            break
        fi
    done

    if [ -n "$source" ]; then
        mkdir -p "$INSTANCE_DIR/$name"
        cp -R "$source/." "$INSTANCE_DIR/$name/"
    fi
}

if [ -n "$TEMPLATE_DIR" ]; then
    cp -R "$TEMPLATE_DIR/." "$INSTANCE_DIR/"
    mkdir -p "$INSTANCE_DIR/components"
fi

copy_asset_dir layouts
copy_asset_dir transitions

if [ ! -f "$INSTANCE_DIR/input.json" ]; then
    cat > "$INSTANCE_DIR/input.json" <<'JSON'
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
if (typeof input.layoutPath !== "string" || !input.layoutPath.trim()) {
  input.layoutPath = "layouts/stack.json";
}
if (typeof input.transitionPath !== "string" || !input.transitionPath.trim()) {
  input.transitionPath = "transitions/soft.json";
}
fs.writeFileSync(inputPath, JSON.stringify(input, null, 2) + "\n");
' "$INSTANCE_DIR/input.json"

if [ ! -f "$INSTANCE_DIR/output.json" ]; then
    printf '[]\n' > "$INSTANCE_DIR/output.json"
fi

if [ ! -f "$INSTANCE_DIR/canvas.html" ]; then
    cat > "$INSTANCE_DIR/canvas.html" <<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blank Canvas</title>
  <style>
    html, body {
      margin: 0;
      min-height: 100%;
      background: #0b1120;
    }
  </style>
</head>
<body></body>
</html>
HTML
fi

echo "Created:"
echo "  $INSTANCE_DIR/input.json"
echo "  $INSTANCE_DIR/output.json"
echo "  $INSTANCE_DIR/canvas.html"
echo "  $INSTANCE_DIR/components/"
echo "  $INSTANCE_DIR/layouts/"
echo "  $INSTANCE_DIR/transitions/"
