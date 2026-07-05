#!/bin/bash
set -euo pipefail

CANVAS_NAME="${1:-}"
WORKSPACE_DIR="${2:-${LIQUIDOS_WORKSPACE:-}}"

if [ -z "$CANVAS_NAME" ] || [ -z "$WORKSPACE_DIR" ]; then
    echo "Usage: $0 <canvas-name> <workspace.liquidos>"
    echo ""
    echo "Deletes a canvas from the .liquidos workspace and commits the"
    echo "deletion to the workspace git timeline."
    echo "You may also provide LIQUIDOS_WORKSPACE instead of the second argument."
    exit 1
fi

if [ ! -d "$WORKSPACE_DIR" ]; then
    echo "Error: workspace does not exist: $WORKSPACE_DIR"
    exit 1
fi

WORKSPACE_DIR="$(cd "$WORKSPACE_DIR" && pwd)"

case "$WORKSPACE_DIR" in
    *.liquidos) ;;
    *)
        echo "Error: workspace must be a .liquidos folder: $WORKSPACE_DIR"
        exit 1
        ;;
esac

# Unlike create-instance.sh, deletion is NOT reimplemented in bash. The real
# work lives in the server binary's `delete-canvas` subcommand — the same delete
# + timeline pair the DELETE /canvases/<name> endpoint runs — so the two paths
# can never drift. This skill tree is copied into the agent's sandbox (see
# agent/skills.js), so it can't reach app code by a relative path; the app root
# is baked in at copy time. When run straight from the repo (tests, dev) the
# token is untouched, so fall back to the repo root three levels up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="__LIQUIDOS_APP_ROOT__"
case "$APP_ROOT" in
    __LIQUIDOS_APP_ROOT__) APP_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)" ;;
esac

"$APP_ROOT/go-server/liquidos-server" delete-canvas "$CANVAS_NAME" "$WORKSPACE_DIR"
