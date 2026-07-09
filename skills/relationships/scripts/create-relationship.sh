#!/usr/bin/env bash
set -euo pipefail

#
# create-relationship.sh — scaffolds a relationship inside a canvas.
#
# Usage:
#   bash skills/relationships/scripts/create-relationship.sh \
#     <canvas-path> <from> <to> [--name <custom>]
#
# A relationship wires <from>'s output into <to>'s input. By default the
# folder is named <from>-to-<to>; pass --name to override.
#
# Either endpoint may be the reserved name `canvas`, which wires the canvas
# itself (canvas.js's root.__io) instead of a component in components/.
#
# What it does:
#   - Verifies <from> and <to> exist under the canvas's components/. The
#     reserved name `canvas` wires the canvas itself and needs no such folder.
#   - Errors if the relationship folder already exists.
#   - Writes functions.js and feature-requirements.txt at the relationship
#     folder root. No view.json — relationships don't render, so the harness
#     synthesizes their component shape from convention. Behavior is verified
#     with a probe under tests/ (see the Testing Skill), not scaffolded here.
#   - Does NOT touch index.json. The server discovers relationships by
#     scanning <canvas>/relationships/.
#
# Output: one-line JSON describing the new relationship.
#

positional=()
custom_name=""

while [ $# -gt 0 ]; do
    case "$1" in
        --help|-h)
            echo "Usage: $0 <canvas-path> <from> <to> [--name <custom>]"
            echo "  <from>/<to> are component folder names, or 'canvas' to wire the canvas itself."
            exit 0
            ;;
        --name)
            shift
            custom_name="${1:-}"
            if [ -z "$custom_name" ]; then
                echo "Error: --name requires a value" >&2
                exit 1
            fi
            shift
            ;;
        *)
            positional+=("$1")
            shift
            ;;
    esac
done

if [ "${#positional[@]}" -lt 3 ]; then
    echo "Usage: $0 <canvas-path> <from> <to> [--name <custom>]" >&2
    exit 1
fi

canvas_dir="${positional[0]}"
from_raw="${positional[1]}"
to_raw="${positional[2]}"

if [ ! -d "$canvas_dir" ]; then
    echo "Error: canvas folder does not exist: $canvas_dir" >&2
    exit 1
fi

if [ ! -f "$canvas_dir/index.json" ]; then
    echo "Error: $canvas_dir/index.json not found (is this a canvas?)" >&2
    exit 1
fi

canvas_dir="$(cd "$canvas_dir" && pwd)"

sanitize() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//'
}

from_name="$(sanitize "$from_raw")"
to_name="$(sanitize "$to_raw")"

if [ -z "$from_name" ] || [ -z "$to_name" ]; then
    echo "Error: <from> and <to> are required (got: $from_raw, $to_raw)" >&2
    exit 1
fi

# The canvas itself is a valid endpoint under the reserved peer name `canvas`
# (canvas.js exposes root.__io). It has no components/<name> folder, so skip
# the component-existence check for that side — but still validate real
# component names so a typo'd endpoint is caught.
reserved_canvas="canvas"

if [ "$from_name" = "$reserved_canvas" ] && [ "$to_name" = "$reserved_canvas" ]; then
    echo "Error: both endpoints are 'canvas' — a relationship needs two distinct endpoints" >&2
    exit 1
fi

if [ "$from_name" != "$reserved_canvas" ] && [ ! -d "$canvas_dir/components/$from_name" ]; then
    echo "Error: <from> component not found: components/$from_name (use 'canvas' to wire the canvas itself)" >&2
    exit 1
fi
if [ "$to_name" != "$reserved_canvas" ] && [ ! -d "$canvas_dir/components/$to_name" ]; then
    echo "Error: <to> component not found: components/$to_name (use 'canvas' to wire the canvas itself)" >&2
    exit 1
fi

if [ -n "$custom_name" ]; then
    rel_name="$(sanitize "$custom_name")"
    if [ -z "$rel_name" ]; then
        echo "Error: --name produced empty after sanitize: $custom_name" >&2
        exit 1
    fi
else
    rel_name="${from_name}-to-${to_name}"
fi

rel_dir="$canvas_dir/relationships/$rel_name"

if [ -e "$rel_dir" ]; then
    echo "Error: relationship already exists: $rel_dir" >&2
    exit 1
fi

mkdir -p "$rel_dir"

# feature-requirements.txt — plain text, user-facing, describes the wiring.
cat > "$rel_dir/feature-requirements.txt" <<TXT
- Forwards data from ${from_name} to ${to_name}. Edit this line to describe what the wire actually does.
TXT

# functions.js — connect() stub. The agent fills in channel names and the
# transform function. Naming the two peers via interpolation makes the
# starting point grep-able from the relationship name.
cat > "$rel_dir/functions.js" <<FUNCTIONSJS
//
// ${rel_name} — relationship.
//
// Wires ${from_name} -> ${to_name}. The harness calls connect(peers) once
// with the I/O handles of every sibling, keyed by local name. This
// relationship subscribes to ${from_name} and writes to ${to_name}.
//
// CONTRACT
// - mount() returns a cleanup function that runs whenever this relationship
//   is re-mounted (live file edit) or removed. It MUST call the
//   unsubscribe returned by on().
// - connect() must be robust to missing peers — return early if either
//   endpoint isn't in the canvas.
//
// AGENT FREEDOM
// Fill in:
//   - the channel name the from-peer publishes on (in from.on('<channel>', ...))
//   - the channel name the to-peer accepts (in to.send('<channel>', ...))
//   - the transform function (or remove it for a passthrough)
// Replace anything else as needed. For fanout or fan-in, restructure
// connect() — the contract only requires that surface.__io.connect exists.
//

export const mount = (surface) => {
    let off = null;

    surface.__io = {
        // Declared peers: the harness wires this relationship the instant both
        // are present — no waiting, no timeout. Keep this list in sync with the
        // peers connect() looks up below.
        peers: ['${from_name}', '${to_name}'],
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const from = peers['${from_name}'];
            const to = peers['${to_name}'];
            if (!from || !to) return;

            // TODO: replace '<channel>' on both sides, and the transform.
            off = from.on('<channel>', payload => {
                to.send('<channel>', payload);
            });
        },
    };

    return () => {
        if (off) { try { off(); } catch {} ; off = null; }
    };
};
FUNCTIONSJS

printf '{"relationship":"%s","from":"%s","to":"%s","path":"%s"}\n' \
    "$rel_name" "$from_name" "$to_name" "$rel_dir"
