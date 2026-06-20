#!/usr/bin/env bash
set -euo pipefail

#
# delete-component.sh — removes a component from a canvas.
#
# Usage:
#   bash skills/component/scripts/delete-component.sh \
#     <canvas-path> <component-name>
#
# What it does:
#   - Removes the component's entry from the canvas index.json's
#     components array (first, so the harness stops watching the
#     folder and won't recreate diagnostics/ under it).
#   - Removes the component folder at <canvas>/components/<name>/.
#   - Cascades: removes any relationship that declared this component as a
#     peer (it can never wire again), keyed off its __io.peers.
#
# Idempotent: succeeds quietly when the component is already absent
# from either side. This makes it safe to call as a cleanup step
# without first checking state.
#
# Output: one-line JSON describing the removed component.
#

positional=()

for arg in "$@"; do
    case "$arg" in
        --help|-h)
            echo "Usage: $0 <canvas-path> <component-name>"
            exit 0
            ;;
        *)
            positional+=("$arg")
            ;;
    esac
done

if [ "${#positional[@]}" -lt 2 ]; then
    echo "Usage: $0 <canvas-path> <component-name>" >&2
    exit 1
fi

canvas_dir="${positional[0]}"
raw_name="${positional[1]}"

if [ ! -d "$canvas_dir" ]; then
    echo "Error: canvas folder does not exist: $canvas_dir" >&2
    exit 1
fi

if [ ! -f "$canvas_dir/index.json" ]; then
    echo "Error: $canvas_dir/index.json not found (is this a canvas?)" >&2
    exit 1
fi

canvas_dir="$(cd "$canvas_dir" && pwd)"

# Sanitize name: lowercase, alphanumeric + dashes/underscores only.
safe_name="$(printf '%s' "$raw_name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"

if [ -z "$safe_name" ]; then
    echo "Error: component name is required (got: $raw_name)" >&2
    exit 1
fi

component_dir="$canvas_dir/components/$safe_name"

# Drop the entry from index.json first. Doing this before the filesystem
# delete prevents the harness's component watcher from racing back and
# rewriting diagnostics/ under a folder that's about to disappear.
node -e '
const fs = require("fs");
const [indexPath, componentPath] = process.argv.slice(1);
const input = JSON.parse(fs.readFileSync(indexPath, "utf8"));
if (!Array.isArray(input.components)) input.components = [];
const before = input.components.length;
input.components = input.components.filter(p => p !== componentPath);
if (input.components.length !== before) {
    fs.writeFileSync(indexPath, JSON.stringify(input, null, 2) + "\n");
}
' "$canvas_dir/index.json" "components/$safe_name/component.html"

# Now remove the folder. rm -rf is fine when missing — idempotent.
rm -rf "$component_dir"

# Cascade: a relationship that declares this component as a peer is now
# orphaned (its peer can never appear), so remove it. We key off the
# declared `__io.peers` — the authoritative list of what a relationship
# wires. The runtime wiring already degrades gracefully (the relationship
# just reports `waiting`); this keeps the workspace tidy.
removed_rels=""
rels_dir="$canvas_dir/relationships"
if [ -d "$rels_dir" ]; then
    for rel_dir in "$rels_dir"/*/; do
        [ -d "$rel_dir" ] || continue
        fn="$rel_dir/functions.js"
        [ -f "$fn" ] || continue
        peers="$(grep -oE "peers:[[:space:]]*\[[^]]*\]" "$fn" | head -1)"
        if printf '%s' "$peers" | grep -qE "['\"]${safe_name}['\"]"; then
            rm -rf "$rel_dir"
            removed_rels="${removed_rels:+$removed_rels,}\"$(basename "$rel_dir")\""
        fi
    done
    # Drop relationships/ entirely if nothing's left.
    rmdir "$rels_dir" 2>/dev/null || true
fi

printf '{"component":"%s","path":"%s","removedRelationships":[%s]}\n' "$safe_name" "$component_dir" "$removed_rels"
