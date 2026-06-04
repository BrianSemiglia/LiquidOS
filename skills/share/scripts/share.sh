#!/bin/bash
set -euo pipefail

#
# share.sh — publish a canvas as a discoverable bundle for peers.
#
# Usage:
#   bash skills/share/scripts/share.sh \
#       <workspace.liquidos> <canvas-name> \
#       [--subtitle "one-line pitch"] \
#       [--tags "tag1,tag2,tag3"]
#
# One shot: build the bundle, write feed metadata, install into
# <workspace>/.share/, regenerate the feed, and flip share.json on.
# The agent doesn't post-edit anything afterward.
#
# Subtitle and tags are optional but strongly recommended — without
# them, peers see the bundle in the feed with no description and few
# people will install it.
#

WORKSPACE_DIR=""
CANVAS_NAME=""
SUBTITLE=""
TAGS=""

while [ $# -gt 0 ]; do
    case "$1" in
        --subtitle)
            shift
            SUBTITLE="${1:-}"
            shift
            ;;
        --tags)
            shift
            TAGS="${1:-}"
            shift
            ;;
        --help|-h)
            echo "Usage: $0 <workspace.liquidos> <canvas-name> [--subtitle \"...\"] [--tags \"tag1,tag2\"]"
            exit 0
            ;;
        *)
            if [ -z "$WORKSPACE_DIR" ]; then
                WORKSPACE_DIR="$1"
            elif [ -z "$CANVAS_NAME" ]; then
                CANVAS_NAME="$1"
            else
                echo "Error: unexpected argument: $1" >&2
                exit 1
            fi
            shift
            ;;
    esac
done

if [ -z "$WORKSPACE_DIR" ] || [ -z "$CANVAS_NAME" ]; then
    echo "Usage: $0 <workspace.liquidos> <canvas-name> [--subtitle \"...\"] [--tags \"tag1,tag2\"]" >&2
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

SHARE_DIR="$WORKSPACE_DIR/.share"
PUBLISHED_DIR="$SHARE_DIR/published"
BUNDLES_DIR="$SHARE_DIR/bundles"
BUNDLE_DIR="$PUBLISHED_DIR/$CANVAS_NAME"

mkdir -p "$PUBLISHED_DIR" "$BUNDLES_DIR"

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

# Feed metadata from the args. Empty files when not provided.
printf '%s' "$SUBTITLE" > "$BUNDLE_DIR/canvas-subtitle.txt"
# Tags: comma-separated input -> one tag per line, trimmed, blanks dropped.
printf '%s' "$TAGS" | tr ',' '\n' | awk 'NF{$1=$1;print}' > "$BUNDLE_DIR/canvas-tags.txt"

# Component requirements: walk input.json.components, copy each
# component's presented/feature-requirements.txt under its leaf name.
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
    COMPONENT_LEAF="$(basename "$COMPONENT_REL")"
    COMPONENT_REQ_SRC="$CANVAS_DIR/$COMPONENT_REL/presented/feature-requirements.txt"
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

# TAR the bundle. Canvas name lands at the archive root for easy unpack.
(cd "$PUBLISHED_DIR" && tar -cf "$BUNDLES_DIR/$HASH.tar" "$CANVAS_NAME")

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
