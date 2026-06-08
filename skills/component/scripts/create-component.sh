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
#   - Writes component.html (entry — wraps the file declarations in
#     <liquidos-component>), feature-requirements.txt, view.html (template),
#     view.json (loading placeholder), functions.js (no-op mount stub),
#     start.sh (service launcher), render.js (view.html → view.json watcher),
#     and IO.swift (no-op native side) — all at the component folder root.
#   - Creates empty data/ and diagnostics/ directories.
#   - Appends components/<name>/component.html to the canvas input.json's
#     components array.
#
# Every scaffolded file is starting clay. The agent should restructure
# freely when the default shape doesn't fit the component.
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

mkdir -p "$component_dir/data" "$component_dir/diagnostics"

# diagnostics/status.json — populated by the harness when something goes wrong.
# The agent reads this file as its first move when fixing a broken component.
printf '{}\n' > "$component_dir/diagnostics/status.json"

# component.html ------------------------------------------------------------
# The entry. cssLayout (and old-shape canvases) load this file and inject
# its contents into the surface. <liquidos-component> provides the standard
# chrome (Requirements/Repair). <liquidos-file> elements observe view.json
# and run start.sh / functions.js.
cat > "$component_dir/component.html" <<HTML
<liquidos-component path="components/${safe_name}">
    <liquidos-file path="components/${safe_name}/start.sh" run></liquidos-file>
    <liquidos-file path="components/${safe_name}/view.json"></liquidos-file>
    <liquidos-file path="components/${safe_name}/functions.js" script></liquidos-file>
</liquidos-component>
HTML

# feature-requirements.txt ---------------------------------------------------
# Plain text. No title — the title lives in view.json. Body is the requirements
# the user cares about, one per line, in their words.
cat > "$component_dir/feature-requirements.txt" <<TXT
- Describe the first thing this component should do.
TXT

# view.html (template) ------------------------------------------------------
# The agent's editing surface during work. render.js watches this file and
# regenerates view.json on every change. Mustache-style placeholders are
# substituted at render time. No service restart on edit.
cat > "$component_dir/view.html" <<HTML
<!--
view.html — agent's editing surface.

Plain HTML. render.js watches this file, substitutes runtime placeholders,
and writes view.json. <liquidos-file path="components/${safe_name}/view.json">
paints view.json. Editing this file does NOT restart the service;
render.js notices and re-emits.

Available placeholders (mustache-style, double curly braces): port, origin,
dispatchId. Add more by extending render.js.

Do NOT put script tags here. Scripts injected via innerHTML do not execute
(browser spec). Put browser-side JavaScript in functions.js inside an
exported mount(surface) function. The harness imports functions.js as a
real ES module.
-->
<div style="padding:1.5rem;display:grid;gap:0.5rem;color:rgba(255,255,255,.8);font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
    <h2 style="margin:0;font-size:1.1rem;font-weight:600;">${display_title}</h2>
    <p style="margin:0;color:rgba(255,255,255,.6);">Loading…</p>
</div>
HTML

# view.json (initial loading state) ----------------------------------------
# Initial paint until render.js boots. render.js overwrites this on startup.
node -e '
const fs = require("fs");
const [path, html] = process.argv.slice(1);
fs.writeFileSync(path, JSON.stringify({ html }, null, 2) + "\n");
' "$component_dir/view.json" "<div style=\"padding:1.5rem;display:grid;gap:0.5rem;color:rgba(255,255,255,.8);font-family:-apple-system,BlinkMacSystemFont,sans-serif;\"><h2 style=\"margin:0;font-size:1.1rem;font-weight:600;\">${display_title}</h2><p style=\"margin:0;color:rgba(255,255,255,.6);\">Loading…</p></div>"

# functions.js (no-op mount stub) ------------------------------------------
cat > "$component_dir/functions.js" <<'FUNCTIONSJS'
//
// functions.js — interactive behavior for this component.
//
// CONTRACT
// export const mount = (surface) => {
//   // surface is the component's DOM root. Scope queries with
//   // surface.querySelector(...) to avoid colliding with other components.
//   //
//   // Optionally return a cleanup function; the harness calls it before
//   // re-mounting on the next view.json change.
//   return () => {}
// }
//
// WHY NOT INLINE <script>?
// <script> tags injected via innerHTML do not execute (browser spec). This
// module runs as a real ES module — your code actually runs, gets its own
// scope, and gets the component root as a parameter.
//
// AGENT FREEDOM
// For a purely static component, leave mount as a no-op or delete this
// file (and remove the <liquidos-file ... script> line from component.html).
//

export const mount = (surface) => {
    // No-op default. Add behavior here.
}
FUNCTIONSJS

# start.sh ------------------------------------------------------------------
cat > "$component_dir/start.sh" <<'STARTSH'
#!/usr/bin/env bash
#
# start.sh — launches this component's services.
#
# CONTRACT
# The harness invokes this with a unique dispatch id:
#   start.sh <dispatch-id>
# Stay alive while the services are alive. The harness terminates the
# process group when it wants services to stop.
#
# DEFAULT BEHAVIOR
# - Exports LIQUIDOS_DISPATCH_ID for child processes.
# - Compiles IO.swift to a per-dispatch binary (if IO.swift exists).
# - Launches render.js (if render.js exists).
# - Exits when any started service dies.
#
# AGENT FREEDOM
# Replace, extend, or simplify as the component requires. Delete IO.swift
# to skip the native side; delete render.js to skip the JS side.
#

set -euo pipefail
cd "$(dirname "$0")"

dispatch_id="${1:?missing dispatch id}"
export LIQUIDOS_DISPATCH_ID="$dispatch_id"
runtime_dir="data/.runtime/${dispatch_id}"
mkdir -p "${runtime_dir}"

render_pid=""
io_pid=""

stop() {
    trap - TERM INT EXIT
    if [ -n "${render_pid}" ] && kill -0 "${render_pid}" 2>/dev/null; then
        kill -TERM "${render_pid}" 2>/dev/null || true
    fi
    if [ -n "${io_pid}" ] && kill -0 "${io_pid}" 2>/dev/null; then
        kill -TERM "${io_pid}" 2>/dev/null || true
    fi
    wait 2>/dev/null || true
}
trap stop TERM INT EXIT

if [ -f IO.swift ]; then
    io_binary="${runtime_dir}/IO"
    if [ ! -x "${io_binary}" ] || [ IO.swift -nt "${io_binary}" ]; then
        swiftc IO.swift -o "${io_binary}"
        chmod +x "${io_binary}"
    fi
    "${io_binary}" &
    io_pid=$!
fi

if [ -f render.js ]; then
    node render.js &
    render_pid=$!
fi

if [ -z "${render_pid}" ] && [ -z "${io_pid}" ]; then
    echo "start.sh: no services configured (add render.js or IO.swift)" >&2
    exit 1
fi

while true; do
    if [ -n "${render_pid}" ] && ! kill -0 "${render_pid}" 2>/dev/null; then
        exit 1
    fi
    if [ -n "${io_pid}" ] && ! kill -0 "${io_pid}" 2>/dev/null; then
        exit 1
    fi
    sleep 2
done
STARTSH
chmod +x "$component_dir/start.sh"

# render.js -----------------------------------------------------------------
cat > "$component_dir/render.js" <<'RENDERJS'
//
// render.js — watches view.html and produces view.json.
//
// PURPOSE
// Reads view.html, substitutes runtime placeholders ({{port}}, {{origin}},
// {{dispatchId}}), and writes view.json atomically. <liquidos-file> paints
// view.json; the agent edits view.html. Editing view.html does NOT restart
// the service — render.js notices via fs.watch and re-emits.
//
// CONTRACT
// - Stays alive while the component is alive.
// - Writes view.json whenever view.html changes.
// - Listens on an ephemeral HTTP port so {{port}} resolves to something real.
//   Use this port to expose component-local endpoints (SSE, fetch) if needed.
//
// AGENT FREEDOM
// Add more substitutions, watch additional files (e.g. data/*.json), stream
// SSE to the browser, fetch external state — whatever the component needs.
// Editing this file restarts the service.
//

import http from "node:http"
import { readFile, writeFile, rename, watch } from "node:fs/promises"

const here = new URL(".", import.meta.url)
const templatePath = new URL("view.html", here)
const viewPath = new URL("view.json", here)
const temporaryViewPath = new URL("view.json.tmp", here)

const dispatchId = process.env.LIQUIDOS_DISPATCH_ID || "unknown"

const substitute = (template, values) =>
    template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
        key in values ? String(values[key]) : match
    )

const log = (...values) =>
    console.log(new Date().toISOString(), "render.js:", ...values)

const buildView = async (origin) => {
    const template = await readFile(templatePath, "utf8")
    const url = new URL(origin)
    const html = substitute(template, {
        port: url.port,
        origin,
        dispatchId,
    })
    return { html }
}

let renderInFlight = false
let renderQueued = false

const render = async (origin) => {
    if (renderInFlight) { renderQueued = true; return }
    renderInFlight = true
    try {
        const view = await buildView(origin)
        await writeFile(temporaryViewPath, JSON.stringify(view, null, 2) + "\n")
        await rename(temporaryViewPath, viewPath)
        log("rendered", origin)
    } catch (error) {
        log("render error:", error.message)
    } finally {
        renderInFlight = false
        if (renderQueued) { renderQueued = false; render(origin) }
    }
}

const server = http.createServer((request, response) => {
    response.writeHead(404)
    response.end()
})

server.listen(0, "127.0.0.1", async () => {
    const origin = `http://127.0.0.1:${server.address().port}`
    log("listening", origin)
    await render(origin)

    // Watch view.html for changes and re-render.
    try {
        const watcher = watch(templatePath)
        for await (const _event of watcher) {
            await render(origin)
        }
    } catch (error) {
        log("watch error:", error.message)
    }
})
RENDERJS

# IO.swift ------------------------------------------------------------------
cat > "$component_dir/IO.swift" <<'SWIFT'
//
// IO.swift — native side of this component.
//
// PURPOSE
// Runs alongside render.js as a separate process. Use this when the component
// needs native macOS capabilities (AVFoundation, IOKit, ScreenCaptureKit,
// etc.) that aren't available to JavaScript. The convention is to write
// observations to data/<file>.json that render.js reads to update the view.
//
// CONTRACT
// - Compiled on demand by start.sh via swiftc.
// - Stays alive while the component is alive (RunLoop.main.run()).
// - Communicates with render.js via shared files under data/, not stdin/stdout.
//
// IF YOU DON'T NEED NATIVE
// Delete this file. start.sh will skip the compile/spawn step automatically.
//

import Foundation

// No-op default. Replace with whatever native work this component needs.
RunLoop.main.run()
SWIFT

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
