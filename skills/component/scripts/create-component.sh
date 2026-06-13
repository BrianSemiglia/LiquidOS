#!/usr/bin/env bash
set -euo pipefail

#
# create-component.sh — scaffolds a new-shape component inside a canvas.
#
# Usage:
#   bash skills/component/scripts/create-component.sh \
#     <canvas-path> <component-name>
#
# What it does:
#   - Errors if the component folder already exists.
#   - Writes the smallest viable component:
#       component.html         (an empty <liquidos-component> wrapper)
#       feature-requirements.txt
#       diagnostics/status.json
#   - Appends components/<name>/component.html to the canvas input.json's
#     components array.
#
# That's the whole scaffold. The agent fills in component.html with its
# inline HTML/CSS, and adds whatever else the component needs
# (functions.js for interactivity, a <liquidos-file run> service that
# patches the live view over stdout for a backend, native binaries, data
# files) on top.
#
# Output: one-line JSON describing the new component.
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

# Display title with spaces, e.g. "rainbow-keyboard" -> "Rainbow Keyboard".
display_title="$(printf '%s' "$safe_name" | awk -F'[-_]' '{ out=""; for (i=1; i<=NF; i++) { if (i>1) out=out " "; out=out toupper(substr($i,1,1)) substr($i,2) } print out }')"

component_dir="$canvas_dir/components/$safe_name"

if [ -e "$component_dir" ]; then
    echo "Error: component already exists: $component_dir" >&2
    exit 1
fi

mkdir -p "$component_dir/diagnostics"

# tests/ and data/ — empty, but present so the obvious move is the right one:
# drop probes in tests/ (the testing skill saves them here), and persist
# user-produced state to a file in data/ rather than reaching for
# localStorage (which doesn't travel with the component).
mkdir -p "$component_dir/tests" "$component_dir/data"

# diagnostics/status.json — populated by the harness when something goes wrong.
# The agent reads this file as its first move when fixing a broken component.
printf '{}\n' > "$component_dir/diagnostics/status.json"

# component.html ------------------------------------------------------------
# An empty <liquidos-component> wrapper. The agent fills the body in
# directly with whatever inline HTML/CSS the component needs (and adds
# <liquidos-file path="..." script> for functions.js, <liquidos-file
# path="..." run> for a service, when it actually needs them).
cat > "$component_dir/component.html" <<HTML
<liquidos-component path="components/${safe_name}">
</liquidos-component>
HTML

# feature-requirements.txt --------------------------------------------------
# Plain text. Body is the requirements the user cares about, one per line.
cat > "$component_dir/feature-requirements.txt" <<TXT
- Describe the first thing this component should do.
TXT

# Append components/<name>/component.html to canvas input.json (preserve every
# other key and entry; skip if already present).
node -e '
const fs = require("fs");
const [inputPath, componentPath] = process.argv.slice(1);
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
if (!Array.isArray(input.components)) input.components = [];
if (!input.components.includes(componentPath)) input.components.push(componentPath);
fs.writeFileSync(inputPath, JSON.stringify(input, null, 2) + "\n");
' "$canvas_dir/input.json" "components/$safe_name/component.html"

printf '{"component":"%s","path":"%s"}\n' "$safe_name" "$component_dir"
