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
#   - Removes the component's entry from the canvas input.json's
#     components array (first, so the harness stops watching the
#     folder and won't recreate diagnostics/ under it).
#   - Removes the component folder at <canvas>/components/<name>/.
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

if [ ! -f "$canvas_dir/input.json" ]; then
    echo "Error: $canvas_dir/input.json not found (is this a canvas?)" >&2
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

# Drop the entry from input.json first. Doing this before the filesystem
# delete prevents the harness's component watcher from racing back and
# rewriting diagnostics/ under a folder that's about to disappear.
node -e '
const fs = require("fs");
const [inputPath, componentPath] = process.argv.slice(1);
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
if (!Array.isArray(input.components)) input.components = [];
const before = input.components.length;
input.components = input.components.filter(p => p !== componentPath);
if (input.components.length !== before) {
    fs.writeFileSync(inputPath, JSON.stringify(input, null, 2) + "\n");
}
' "$canvas_dir/input.json" "components/$safe_name/component.html"

# Now remove the folder. rm -rf is fine when missing — idempotent.
rm -rf "$component_dir"

printf '{"component":"%s","path":"%s"}\n' "$safe_name" "$component_dir"
