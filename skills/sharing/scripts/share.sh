#!/bin/bash
set -euo pipefail

#
# share.sh — publish a canvas's requirements for peers to discover.
#
# Usage:
#   bash skills/sharing/scripts/share.sh <workspace.liquidos> <canvas-name>
#
# Copies the canvas's feature-requirements.txt and each shared
# component's feature-requirements.txt into <workspace>/.share/published/
# <canvas>/, regenerates the feed, and flips share.json on.
#

WORKSPACE_DIR="${1:-}"
CANVAS_NAME="${2:-}"

if [ -z "$WORKSPACE_DIR" ] || [ -z "$CANVAS_NAME" ]; then
    echo "Usage: $0 <workspace.liquidos> <canvas-name>" >&2
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

INDEX_PATH="$CANVAS_DIR/index.json"

if [ ! -f "$INDEX_PATH" ]; then
    echo "Error: canvas has no index.json: $INDEX_PATH" >&2
    exit 1
fi

SHARE_DIR="$WORKSPACE_DIR/.share"
PUBLISHED_DIR="$SHARE_DIR/published"
BUNDLE_DIR="$PUBLISHED_DIR/$CANVAS_NAME"

mkdir -p "$PUBLISHED_DIR"

# Republish = full overwrite. Take the old bundle down first.
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/components"

# Canvas-level feature-requirements.txt (always include, even if empty).
CANVAS_REQ_SRC="$CANVAS_DIR/feature-requirements.txt"
CANVAS_REQ_DEST="$BUNDLE_DIR/feature-requirements.txt"
if [ -f "$CANVAS_REQ_SRC" ]; then
    cp "$CANVAS_REQ_SRC" "$CANVAS_REQ_DEST"
else
    : > "$CANVAS_REQ_DEST"
fi

# Component requirements: walk index.json.components, copy each
# component's feature-requirements.txt under its leaf name.
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
' "$INDEX_PATH")

for COMPONENT_REL in "${COMPONENT_PATHS[@]+"${COMPONENT_PATHS[@]}"}"; do
    COMPONENT_DIR="$(dirname "$COMPONENT_REL")"
    COMPONENT_LEAF="$(basename "$COMPONENT_DIR")"

    # Per-component opt-out: components default to inheriting the canvas's
    # share state. A component's share.json with { "shared": false } excludes
    # it from the bundle.
    COMPONENT_SHARE_FILE="$CANVAS_DIR/$COMPONENT_DIR/share.json"
    if [ -f "$COMPONENT_SHARE_FILE" ]; then
        IS_SHARED="$(node -e '
try {
    const obj = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(obj && obj.shared === false ? "no" : "yes");
} catch { process.stdout.write("yes"); }
' "$COMPONENT_SHARE_FILE")"
        if [ "$IS_SHARED" = "no" ]; then
            continue
        fi
    fi

    COMPONENT_REQ_SRC="$CANVAS_DIR/$COMPONENT_DIR/feature-requirements.txt"
    COMPONENT_REQ_DEST="$BUNDLE_DIR/components/$COMPONENT_LEAF/feature-requirements.txt"
    mkdir -p "$BUNDLE_DIR/components/$COMPONENT_LEAF"
    if [ -f "$COMPONENT_REQ_SRC" ]; then
        cp "$COMPONENT_REQ_SRC" "$COMPONENT_REQ_DEST"
    else
        : > "$COMPONENT_REQ_DEST"
    fi
done

# Compute the bundle's content hash (mirrors feed.sh's deterministic walk).
HASH="$(node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const root = process.argv[1];
const hash = crypto.createHash("sha256");
const walk = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const sub = rel ? rel + "/" + entry.name : entry.name;
        if (entry.isDirectory()) {
            walk(full, sub);
        } else if (entry.isFile()) {
            const buf = fs.readFileSync(full);
            hash.update(sub);
            hash.update(Buffer.from([0]));
            hash.update(buf);
        }
    }
};
walk(root, "");
process.stdout.write("sha256-" + hash.digest("hex"));
' "$BUNDLE_DIR")"

# Regenerate the feed from every currently published bundle.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/feed.sh" "$PUBLISHED_DIR" "$SHARE_DIR/feed.json" >/dev/null

# Flip the discoverability switch on.
SHARE_FILE="$CANVAS_DIR/share.json"
echo '{ "shared": true }' > "$SHARE_FILE"

# One-line JSON summary.
node -e '
process.stdout.write(JSON.stringify({
    canvas: process.argv[1],
    hash: process.argv[2],
    bundle: process.argv[3],
    shared: true
}) + "\n");
' "$CANVAS_NAME" "$HASH" "$BUNDLE_DIR"
