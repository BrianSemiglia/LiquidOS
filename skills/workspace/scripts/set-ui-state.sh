#!/usr/bin/env bash
set -euo pipefail

#
# set-ui-state.sh — show/hide the workspace's system panels for the user.
#
# Usage:
#   bash skills/workspace/scripts/set-ui-state.sh <workspace.liquidos> \
#        (--engaged | --disengaged <surface>) [--component <scope> | --no-component]
#
# The surface is either ENGAGED (normal) or DISENGAGED into one of three
# mutually exclusive surfaces, with a component's requirements editor as an
# independent layer on top:
#
#   --engaged                          normal: prompt bar up, nothing stepped back
#   --disengaged prompt                escape mode: prompt bar hidden for a clean canvas
#   --disengaged canvasPicker          the "Spaces" grid of all canvases
#   --disengaged canvasRequirements    the active canvas's requirements editor
#
#   --component <scope>                open one component's requirements editor (by its
#                                      folder scope — the same string used for agent jobs)
#   --no-component                     close the component requirements editor
#
# The engaged/disengaged surface and the component editor are orthogonal: this
# MERGES with the current ui-state.json, so changing one leaves the other alone.
# Pass an engaged/disengaged flag, a component flag, or both.
#
# Examples:
#   set-ui-state.sh <ws> --disengaged prompt              # clean canvas
#   set-ui-state.sh <ws> --disengaged canvasPicker        # open the Spaces picker
#   set-ui-state.sh <ws> --component home/components/clock # open a component's requirements
#   set-ui-state.sh <ws> --engaged --no-component         # back to normal, nothing open
#
# Output: one-line JSON of the resulting state.
#

usage() {
    sed -n '5,33p' "$0" | sed 's/^# \{0,1\}//'
}

WORKSPACE_DIR=""
MODE=""
MODE_SET=0        # 0 = leave the engaged/disengaged surface as-is
COMPONENT=""
COMPONENT_SET=0   # 0 = leave componentRequirements as-is

set_mode() {
    if [ "$MODE_SET" -eq 1 ]; then
        echo "Error: pass only one of --engaged / --disengaged" >&2
        exit 1
    fi
    MODE="$1"
    MODE_SET=1
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h)
            usage; exit 0
            ;;
        --engaged)
            set_mode engaged; shift
            ;;
        --disengaged)
            surface="${2:-}"
            case "$surface" in
                prompt|canvasPicker|canvasRequirements) ;;
                *)
                    echo "Error: --disengaged needs a surface: prompt | canvasPicker | canvasRequirements" >&2
                    exit 1
                    ;;
            esac
            set_mode "$surface"; shift 2
            ;;
        --component)
            COMPONENT="${2:-}"; COMPONENT_SET=1; shift 2
            ;;
        --no-component)
            COMPONENT=""; COMPONENT_SET=1; shift
            ;;
        -*)
            echo "Error: unknown flag: $1" >&2
            exit 1
            ;;
        *)
            if [ -z "$WORKSPACE_DIR" ]; then WORKSPACE_DIR="$1"; else
                echo "Error: unexpected argument: $1" >&2; exit 1
            fi
            shift
            ;;
    esac
done

if [ -z "$WORKSPACE_DIR" ]; then
    WORKSPACE_DIR="${LIQUIDOS_WORKSPACE:-}"
fi

if [ -z "$WORKSPACE_DIR" ]; then
    usage >&2
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

if [ "$MODE_SET" -eq 0 ] && [ "$COMPONENT_SET" -eq 0 ]; then
    echo "Error: nothing to do — pass --engaged / --disengaged and/or --component / --no-component" >&2
    exit 1
fi

# Read-merge-write so the surface and the component editor stay independent: an
# absent file defaults to engaged with nothing open; only the flags passed change.
node -e '
const fs = require("fs");
const [file, mode, modeSet, component, componentSet] = process.argv.slice(1);
const MODES = ["engaged", "prompt", "canvasPicker", "canvasRequirements"];
let state = {};
try { const p = JSON.parse(fs.readFileSync(file, "utf8")); if (p && typeof p === "object") state = p; } catch {}
let nextMode = MODES.includes(state.mode) ? state.mode : "engaged";
if (modeSet === "1") nextMode = mode;
let nextComponent = typeof state.componentRequirements === "string" ? state.componentRequirements : "";
if (componentSet === "1") nextComponent = component;
const out = { mode: nextMode, componentRequirements: nextComponent };
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
process.stdout.write(JSON.stringify(out) + "\n");
' "$WORKSPACE_DIR/ui-state.json" "$MODE" "$MODE_SET" "$COMPONENT" "$COMPONENT_SET"
