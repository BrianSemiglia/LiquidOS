#!/bin/bash
set -e

INSTANCE_NAME="$1"

if [ -z "$INSTANCE_NAME" ]; then
    echo "Usage: $0 <instance-name>"
    echo ""
    echo "Creates a new canvas instance under canvases/<instance-name>/"
    exit 1
fi

# Project root: where server.js lives
# Try current directory first, then search upward
PROJECT_ROOT=""
if [ -f "server.js" ]; then
    PROJECT_ROOT="$(pwd)"
else
    # Search upward for server.js
    DIR="$(pwd)"
    for i in {1..5}; do
        if [ -f "$DIR/server.js" ]; then
            PROJECT_ROOT="$DIR"
            break
        fi
        DIR="$(dirname "$DIR")"
    done
fi

if [ -z "$PROJECT_ROOT" ]; then
    echo "Error: Could not find server.js in current directory or parents."
    echo "Please run from your project root directory."
    exit 1
fi

CANVASES_DIR="$PROJECT_ROOT/canvases"
INSTANCE_DIR="$CANVASES_DIR/$INSTANCE_NAME"

echo "Project root: $PROJECT_ROOT"
echo "Creating canvas instance: $INSTANCE_DIR"
echo ""

# Create instance directory structure
mkdir -p "$INSTANCE_DIR/components"

# Create input.json with empty components array
cat > "$INSTANCE_DIR/input.json" << 'EOF_JSON'
{
  "components": []
}
EOF_JSON

# Create output.json as empty array
cat > "$INSTANCE_DIR/output.json" << 'EOF_JSON'
[]
EOF_JSON

# Copy canvas.html from live-canvas-server template
TEMPLATE_DIR="$HOME/.hermes/skills/software-development/live-canvas-server/templates"
if [ -f "$TEMPLATE_DIR/index.html" ]; then
    cp "$TEMPLATE_DIR/index.html" "$INSTANCE_DIR/canvas.html"
    echo "Created: $INSTANCE_DIR/canvas.html (from template)"
else
    echo "Warning: index.html template not found at $TEMPLATE_DIR"
    echo "Please copy canvas.html from an existing instance or create it manually."
fi

# Copy to server root as index.html (follows convention: http://localhost:PORT/ works directly)
if [ -f "$PROJECT_ROOT/index.html" ]; then
    echo "Warning: index.html already exists at project root, skipping copy"
    echo "  (Manual step: cp $INSTANCE_DIR/canvas.html $PROJECT_ROOT/index.html)"
else
    cp "$INSTANCE_DIR/canvas.html" "$PROJECT_ROOT/index.html"
    echo "Copied to: $PROJECT_ROOT/index.html (serves at http://localhost:PORT/)"
fi

echo ""
echo "Canvas instance created successfully!"
echo ""
echo "  Instance directory: $INSTANCE_DIR"
echo ""
echo "Next steps:"
echo "  1. Add component JSON files to: $INSTANCE_DIR/components/"
echo "  2. Update $INSTANCE_DIR/input.json with component paths"
echo "  3. Copy canvas.html to project root to serve at http://localhost:xxxx/"
echo "     cp $INSTANCE_DIR/canvas.html $PROJECT_ROOT/index.html"
echo "  4. Start the server:"
echo "     node $PROJECT_ROOT/server.js --input $INSTANCE_DIR/input.json --output $INSTANCE_DIR/output.json --port 3000"
echo "  5. Open in browser: http://localhost:3000/"
