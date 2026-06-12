#!/usr/bin/env bash
set -euo pipefail

#
# delete-relationship.sh — removes a relationship from a canvas.
#
# Usage:
#   bash skills/relationships/scripts/delete-relationship.sh <canvas-path> <name>
#   bash skills/relationships/scripts/delete-relationship.sh <canvas-path> <from> <to>
#
# With two args, <name> is the relationship folder name. With three, the name
# is <from>-to-<to> (the create-relationship default).
#
# What it does:
#   - Verifies the canvas and the relationship folder exist.
#   - Removes <canvas>/relationships/<name>/. The server discovers
#     relationships by scanning that folder, so removing it tears the wire
#     down on the next refresh. The client's reactive wiring drops the peer
#     when the surface goes away — no stale subscription.
#   - Removes relationships/ entirely if it's now empty.
#   - Does NOT touch input.json (relationships are not listed there).
#
# Output: one-line JSON describing what was removed.
#

positional=()
while [ $# -gt 0 ]; do
    case "$1" in
        --help|-h)
            echo "Usage: $0 <canvas-path> <name> | $0 <canvas-path> <from> <to>"
            exit 0
            ;;
        *)
            positional+=("$1")
            shift
            ;;
    esac
done

if [ "${#positional[@]}" -lt 2 ]; then
    echo "Usage: $0 <canvas-path> <name> | $0 <canvas-path> <from> <to>" >&2
    exit 1
fi

canvas_dir="${positional[0]}"

if [ ! -d "$canvas_dir" ] || [ ! -f "$canvas_dir/input.json" ]; then
    echo "Error: not a canvas (no input.json): $canvas_dir" >&2
    exit 1
fi
canvas_dir="$(cd "$canvas_dir" && pwd)"

sanitize() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//'
}

if [ "${#positional[@]}" -ge 3 ]; then
    rel_name="$(sanitize "${positional[1]}")-to-$(sanitize "${positional[2]}")"
else
    rel_name="$(sanitize "${positional[1]}")"
fi

if [ -z "$rel_name" ]; then
    echo "Error: relationship name is empty after sanitize" >&2
    exit 1
fi

rel_dir="$canvas_dir/relationships/$rel_name"

if [ ! -d "$rel_dir" ]; then
    echo "Error: relationship not found: relationships/$rel_name" >&2
    exit 1
fi

rm -rf "$rel_dir"

# Keep the canvas tidy: drop relationships/ entirely if nothing's left.
rmdir "$canvas_dir/relationships" 2>/dev/null || true

printf '{"deleted":"%s","path":"%s"}\n' "$rel_name" "$rel_dir"
