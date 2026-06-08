#!/bin/bash
set -euo pipefail

#
# unshare.sh — stop sharing a canvas: remove the published bundle,
# regenerate the feed without it, set share.json = { "shared": false }.
#
# Usage:
#   bash skills/share/scripts/unshare.sh <workspace.liquidos> <canvas-name>
#
# Tolerant of missing pieces (no bundle, no feed entry, no share.json).
# Always sets the share flag off if the canvas still exists, even when
# nothing else needed cleaning up.
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
SHARE_DIR="$WORKSPACE_DIR/.share"
PUBLISHED_DIR="$SHARE_DIR/published"
FEED_FILE="$SHARE_DIR/feed.json"

# Remove the published bundle folder.
rm -rf "$PUBLISHED_DIR/$CANVAS_NAME"

# Rebuild the feed from whatever bundles remain (or write empty).
if [ -d "$PUBLISHED_DIR" ] && [ -n "$(ls -A "$PUBLISHED_DIR" 2>/dev/null || true)" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    bash "$SCRIPT_DIR/feed.sh" "$PUBLISHED_DIR" "$FEED_FILE" >/dev/null
else
    mkdir -p "$SHARE_DIR"
    node -e '
process.stdout.write(JSON.stringify({
    feedVersion: 1,
    bundles: []
}, null, 2) + "\n");
' > "$FEED_FILE"
fi

# Flip the discoverability switch off (if the canvas folder still exists).
if [ -d "$CANVAS_DIR" ]; then
    echo '{ "shared": false }' > "$CANVAS_DIR/share.json"
fi

echo "{\"canvas\":\"$CANVAS_NAME\",\"shared\":false}"
