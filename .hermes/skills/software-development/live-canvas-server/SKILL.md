---
name: live-canvas-server
description: Build and operate a small local live canvas where each canvas instance owns input.json, output.json, and mirrored component JSON files under its components directory, while component file fields point to represented source data outside the instance.
triggers:
  - User asks for a webpage that listens for changes and reloads automatically
  - User requests a live canvas that displays JSON-defined components
  - User mentions input.json, output.json, browser callbacks, page prompts, or agent-driven live editing
  - User asks Hermes to handle prompts submitted from the live canvas page
---

# Live Canvas Server

Use this for small named live canvas instances:

```text
instance/input.json       -> server/page
instance/output.json      -> Hermes when prompted
instance/components/...   -> component JSON files for that instance
```

The server is only the local bridge that lets a browser view an instance `input.json` and append prompt callbacks to that instance's `output.json`. Hermes does not listen to the server, subscribe to SSE, poll HTTP, or run a file-watching loop unless the user explicitly asks for that later.

**Related**: Use `canvas-instance-creator` skill to scaffold new canvas instances.

## Contract

- `server.js` lives in the project root; `index.html` is copied to the project root (served at `http://localhost:PORT/`).
- Each canvas instance has its own `input.json`, `output.json`, and `components/` directory under a named directory such as `canvases/to-the-metal-hairscut/`.
- `input.json` uses absolute paths to component JSON files inside that instance's `components/` directory.
- Component JSON paths mirror the represented data path under `components/`. For `~/Documents/foo.png`, use `instance/components~/Documents/foo.png.component.json`.
- A component JSON's `file` field uses an absolute path to the represented source data or asset.
- `output.json` is an array of prompt callbacks written by the page.
- Hermes processes an instance `output.json` on demand when the user prompts it to handle page prompts.

Do not reintroduce `component.json`, `/component`, `/asset`, or a read API for `output.json`.

## Server Use

Start the server for a specific instance:

**Working Directory**: Must be the project root (e.g., `~/Documents/workspace/live-edit`) where `server.js` resides. Do NOT run from a canvas subdirectory (e.g., `canvases/`) — this causes `MODULE_NOT_FOUND` errors because `server.js` is not in that path.

```bash
# Preferred method: use --canvas flag to auto-set input/output/deltas paths
node server.js --canvas canvases/to-the-metal-hairscut --port 3000

# Legacy method (may not work with newer server versions):
node server.js --input canvases/to-the-metal-hairscut/input.json --output canvases/to-the-metal-hairscut/output.json --port 3000
```

> **Note**: `npm start` runs `node server.js` without explicit `--canvas`, relying on the default canvas set in `server.js`'s `DEFAULT_CANVAS_PATH` (typically `canvases/random-pdfs`). If `npm start` crashes with `ENOENT` for a missing component (e.g., `gallery-explorer.component.json`), use the preferred `node server.js --canvas <valid-canvas>` command instead. Known-good existing canvases include `canvases/test-new-canvas`.

### Background Execution
To avoid terminal timeouts (common when using tools with execution time limits, e.g., Hermes agent's `terminal` tool with 60s timeout), run the server in background mode. This keeps the server running without blocking the terminal:

```bash
# Clean up existing processes on the target port first (user-preferred surgical kill)
kill $(lsof -ti :3000) 2>/dev/null

# Start server in background (Unix)
node server.js --canvas canvases/random-pdfs --port 3000 &
```

For Hermes agent's `terminal` tool, use the `background: true` parameter to start the server as a managed background process, then poll its output with `process action=poll session_id=<id>`.

**Note**: The server automatically switches to newly created canvases (via the "New" button on the canvas page). Validate `input.json` for all canvas instances (not just the default) to prevent startup errors from missing component references. Run the bulk fix script from the relevant canvas directory:

```bash
cd canvases/test-canvas
python3 -c "import json, os; f=open('input.json'); d=json.load(f); d['components']=[c for c in d['components'] if os.path.exists(c)]; open('input.json','w').write(json.dumps(d, indent=2))"
```

The server can host multiple canvas instances simultaneously on the same port. When a canvas is created via `POST /canvases` (the "New" button on the canvas page), the server automatically starts hosting it. Switch between canvases using the dropdown or `POST /canvas` endpoint.

Use another `--port` only if you need a completely separate server process (e.g., for testing different server.js versions).

**Stopping Servers**: Use surgical port-based kills to avoid disrupting unrelated processes:

```bash
# Stop a specific canvas server by port
lsof -ti :3001 | xargs kill 2>/dev/null

# Stop multiple servers
lsof -ti :3001 | xargs kill 2>/dev/null
lsof -ti :3002 | xargs kill 2>/dev/null
lsof -ti :3003 | xargs kill 2>/dev/null
```

Avoid broad `kill` commands (e.g., `pkill -f node`) that could kill unrelated processes. Target specific ports instead.

**URL Convention**: The canvas page is served at root `http://localhost:PORT/` (via `index.html` at server root), NOT `http://localhost:PORT/canvas.html` or `http://localhost:PORT/canvases/name/canvas.html`. Follow this convention — copy `canvas.html` to `index.html` at the server root after creating an instance.

Example workflow:
```bash
# After creating instance with canvas-instance-creator script
cp canvases/random-mp3s/canvas.html index.html
# Now http://localhost:3001/ works directly
```

### Debugging Server Startup
The Hermes background process tool may not capture Node.js startup output due to stdout buffering. When debugging, redirect server output to a log file to capture all output (including errors):

```bash
node server.js --input canvases/example/input.json --output canvases/example/output.json --port 3000 >> /tmp/server-3000.log 2>&1
```

Check the log file with `cat /tmp/server-3000.log` after starting.

**Real-time log monitoring**: When user asks to "watch the logs" or "monitor logs as I use it", start a background `tail -f` process:

```bash
# Start log watcher in background
tail -f /tmp/server-3000.log &

# Poll the tail process to see new output
# Use: process action=poll session_id=<from background start>
```

The background `tail -f` streams new log lines as they're written. Poll the background process session to report activity to the user.

## Canvas Creation via UI

The canvas page has a "New" button (styled with dark background `#1e293b` that may appear disabled/dim but is functional). It calls `POST /canvases` with `{"name": "..."}` to create a new canvas instance. The server automatically starts hosting the new canvas and switches to it.

**Note**: The button uses muted colors (not `disabled` attribute), so it may appear dim/disabled even when fully functional.

## Workflow

**Execute immediately**: When the user asks you to make changes or implement something, start executing right away. Do NOT stop to explain your plan or approach — the user finds this frustrating ("why do you keep stopping?", "are you stuck?"). Read files and make changes in parallel when possible. Explain only after completing the work, if needed.

### Splitting Mixed File Changes
When a file contains both dispatch-related and non-dispatch (e.g., UI cleanup) changes, split them into separate commits:
1. Save full diff: `git diff <file> > /tmp/<file>-full.patch`
2. Restore file to original: `git checkout -- <file>`
3. Apply only the first logical change set (e.g., dispatch changes) via surgical patches
4. Commit with related files (e.g., `server.js` for dispatch changes)
5. Restore the committed version: `git checkout HEAD -- <file>`
6. Apply remaining changes (e.g., UI cleanup) manually
7. Commit separately with descriptive message

This ensures each commit is logically atomic, matching the user's preference for surgical commits (see memory: "User prefers surgical, precise Git commits, splitting logically distinct changes").

### Commit Messages with Known Issues
When committing code with known design issues (e.g., plugin coupling to server internals), add a `NOTE:` section in the commit message to document the concern for future sessions:
```
Update system-volume-watch plugin for concurrent dispatch

[... changes ...]

NOTE: Plugin currently writes componentPath/componentKey directly to output.json,
coupling it to server's dispatch internals. Ideally, plugin should only specify
the target component and let server map to its internal lane system.
```

## Pitfalls

### Server Prompt Type Detection
The server determines prompt type (canvas vs component) by checking the `scope` field in the request body. Simplify logic to just check `scope === 'canvas'`.

Current logic in `appendOutput()`:
```javascript
const isCanvasPrompt = body.scope === 'canvas';
```

**Frontend usage:**
- Canvas prompts: `submitCanvasPrompt()` sends `{ prompt, selectedComponents }` (no `scope` needed - server defaults to canvas)
- Component prompts: `submitPrompt()` sends `{ scope: 'component', target, request }` to explicitly mark component scope

When writing plugins that submit callbacks to `output.json`, include `scope: 'canvas'` or `scope: 'component'` to explicitly declare the prompt type. This is the preferred method over checking `target`/`componentIndex` presence.

### Component File Paths Must Exist

The server watches all files referenced in component JSONs (via `file` field and `resources`). If a component has `"file": "/path/that/does/not/exist"`, the server crashes with `ENOENT: no such file or directory, watch '/path/that/does/not/exist'`.

**Fix**: Always ensure the `file` field points to a real, existing file. Never create test components with fake paths like `"/test/file.txt"`.

**Verification**: Before starting the server, verify all component JSON files and their referenced files exist:
```bash
# Check if all component JSON files and their referenced files exist
node -e "const fs = require('fs'); const input = JSON.parse(fs.readFileSync('./input.json', 'utf8')); input.components.forEach(c => { if (!fs.existsSync(c)) { console.error('Missing component JSON:', c); } else { const comp = JSON.parse(fs.readFileSync(c, 'utf8')); if (comp.file && !fs.existsSync(comp.file)) { console.error('Missing referenced file:', comp.file, 'in', c); } } });"
```

### Missing Component JSON Files in input.json
If `input.json` references a component JSON file that does not exist (e.g., `gallery-explorer.component.json`), the server crashes with `ENOENT: no such file or directory` when trying to read the component. The default `canvases/random-pdfs` canvas is a common example of this issue, as it may reference missing components like `gallery-explorer.component.json`. If you encounter this crash when using `npm start`, switch to a known-good existing canvas such as `canvases/test-new-canvas` instead of creating a new test canvas.

**Fallback**: If the default canvas is broken, create a minimal test canvas to start the server:
1. Create test canvas directories: `mkdir -p canvases/test-canvas/components`
2. Create `canvases/test-canvas/input.json` with a valid component path
3. Create a simple component JSON (e.g., `welcome.component.json` with basic HTML/data)
4. Initialize `output.json` and `deltas.json` as empty arrays: 
   ```bash
   echo '[]' > canvases/test-canvas/output.json && echo '[]' > canvases/test-canvas/deltas.json
   ```
5. Start server with test canvas: `node server.js --canvas canvases/test-canvas --port 3000`

**Bulk Fix**: Remove all missing components from `input.json`:
```python
import json, os
with open('input.json', 'r') as f:
    data = json.load(f)
data['components'] = [c for c in data['components'] if os.path.exists(c)]
with open('input.json', 'w') as f:
    json.dump(data, f, indent=2)
```

### Port Conflicts When Restarting Server
When restarting the server, you may get `Error: listen EADDRINUSE: address already in use :::3000` if a previous instance is still running.

**User Preference**: Surgical port-based process kills (avoid broad `kill -9` commands).

**Fix**: Kill only processes on the target port:
```bash
# Surgical kill (user preference)
lsof -ti :3000 | xargs kill 2>/dev/null
# Then restart the server
node server.js --canvas canvases/example --port 3000
```

Avoid broad kills (e.g., `pkill -f node`) that could disrupt unrelated processes.

### HTTP Plugin Dependency Installation
When setting up the HTTP agent plugin for the first time, you need to create a virtual environment and install dependencies:

```bash
cd ~/.hermes/plugins/http-agent-plugin
python3 -m venv .venv
.venv/bin/pip install fastapi uvicorn pydantic
.venv/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

**Verification**: Test the endpoint before starting the live-edit server:
```bash
curl -s http://localhost:8000/health
# Should return: {"status":"healthy","service":"hermes-http-agent"}
```

**Fallback**: If the default canvas is broken, create a minimal test canvas to start the server:
1. Create test canvas directories: `mkdir -p canvases/test-canvas/components`
2. Create `canvases/test-canvas/input.json` with a valid component path
3. Create a simple component JSON (e.g., `welcome.component.json` with basic HTML/data)
4. Initialize `output.json` and `deltas.json` as empty arrays: 
   ```bash
   echo '[]' > canvases/test-canvas/output.json && echo '[]' > canvases/test-canvas/deltas.json
   ```
5. Start server with test canvas: `node server.js --canvas canvases/test-canvas --port 3000`

### JSON Syntax Errors from Unescaped Quotes in HTML Strings
Component JSON files that contain HTML with unescaped double quotes (e.g., file names like `Spotlights "The Alchemist" (Fan Video).mp3`) cause `JSONDecodeError: Expecting ',' delimiter` when the server tries to parse them.

**Detection**: Validate component JSON files before starting the server:
```bash
python3 -c "import json; json.load(open('canvases/test-canvas/components/downloads-app.json'))"
# If invalid, shows: JSONDecodeError: Expecting ',' delimiter: line 3 column 2598
```

**Root Cause**: The HTML string value in JSON contains literal `"` characters that aren't escaped as `\"`. This happens when:
- File names contain quotes (e.g., `Song "Best" Mix.mp3`)
- HTML attributes aren't properly escaped when building JSON manually
- String concatenation instead of `json.dump()` was used to create the file

**Fix**: Regenerate the component JSON using Python's `json.dump()` which automatically escapes quotes:
```python
import json

# Read the broken file as raw bytes to find unescaped quotes
with open('component.json', 'rb') as f:
    content = f.read()

# If you know the structure, rebuild properly:
component = {
    "id": "downloads-app",
    "html": html_string,  # json.dump() will escape this correctly
    "loading": True,
    "lockedControls": ["search-input"]
}

with open('component.json', 'w') as f:
    json.dump(component, f, indent=2)  # Properly escapes all quotes in html_string
```

**Prevention**: Always use `json.dump()` or `json.dumps()` when writing component JSON files. Never use manual string concatenation or f-strings to build JSON.

**Quick fix script**: See `scripts/fix-json-escaping.py` for programmatic repair of files with unescaped quotes.

### Webhook Integration (New Setup)
The server now uses webhook integration instead of spawning Hermes directly. Key points:

1. **HMAC Secret Synchronization (CRITICAL)**: The `secret` variable in `server.js` and the webhook subscription secret MUST match exactly. Mismatch causes "Invalid signature" errors in gateway.log.
   - After `hermes webhook subscribe`, copy the secret from output
   - Update server.js: `const secret = 'YOUR_SECRET';`
   - Restart server

2. **Webhook Template Variable**: Use `{message}` NOT `{payload.message}`. The webhook adapter uses top-level payload keys, so `{message}` maps to `payload["message"]`.

3. **Rate Limiting with Long Prompts**: Prompts >10k chars (like full agentJobPrompt output ~11627 chars) cause rate limits on free models (openrouter/free). If you see "Rate limited — switching to fallback":
   - Wait 10-15 min for reset
   - Configure a paid model
   - Shorten what the server sends in `agentJobPrompt()`

4. **Architecture**: 
   - Outermost agent reads `live-edit-webhook-setup` skill (infrastructure setup)
   - Webhook dispatches to subagent with `live-edit-app-domain` skill (domain knowledge)
   - Skills travel with project in `.hermes/skills/` directory

5. **Webhook Subscription Command**:
```bash
hermes webhook subscribe liquid-os-agent --prompt "{message}"
```
The `{message}` template expands to the full prompt sent by server.js.

### Iterative Development (User Preference)
When making changes to the live canvas system, implement ONE change at a time. Do NOT bundle multiple features or changes into a single implementation pass.

**Session example**: User asked to simplify the scope logic. I incorrectly implemented BOTH a right-click context input feature AND the scope change. User reverted all changes and said "let's redo just the scope change".

**Correct approach**:
1. User requests scope simplification → only change scope logic
2. Verify it works
3. THEN discuss/implement additional features separately

This aligns with user's preference for "minimal solutions and iterative development - each piece verified before adding next" (see memory).

### Committing Without Verification
User correction: **Do NOT commit until user explicitly verifies and approves changes.** This applies to skill files (`SKILL.md`), `server.js`, and all project files. Even if changes seem correct, wait for user sign-off before `git commit`.

### Skills Travel With Project
All skills for this project MUST live in `.hermes/skills/` directory within the project repo (e.g., `~/Documents/workspace/live-edit/.hermes/skills/`). Do NOT install globally to `~/.hermes/skills/` — skills must travel with the project to other machines.

### When node-pty tries to spawn processes (e.g., Hermes agent via `--agent` flag), you get `Error: posix_spawnp failed.` at `node-pty/lib/unixTerminal.js:92`.

**Root cause**: The `spawn-helper` binary in node-pty's prebuilds directory lacks execute permissions:
- Default: `-rw-r--r--` (no execute bit)
- Required: `-rwxr-xr-x`

**Fix (macOS)**:
```bash
# Fix node-pty spawn-helper permissions (covers all prebuilds, archs, and platforms)
chmod +x node_modules/node-pty/prebuilds/*/electron/*/spawn-helper 2>/dev/null
chmod +x node_modules/node-pty/prebuilds/*/node/*/spawn-helper 2>/dev/null
```

Verify fix:
```bash
node -e "const pty = require('node-pty'); const p = pty.spawn('ls', ['/tmp']); p.onData(d => process.stdout.write(d)); p.onExit(() => process.exit(0));"
```

**Alternative workarounds if fix doesn't work**:
1. **Use Node.js LTS**: Switch to Node.js v22.x via `nvm install 22 && nvm use 22`
2. **Disable Hermes Integration**: Omit `--agent` and `--agent-args` flags

### Agent Tools vs Terminal Commands
Tools like `process` (used for background process management, log polling) are only available to the Hermes agent, not in the user's terminal. For example, running `process --action poll --session proc_XXX` in bash returns `bash: process: command not found`. To check logs or process status, ask the agent to run the `process` tool on your behalf.

### Server Verification
After starting the server, verify it's running correctly:
```bash
# Check if port is in use
lsof -ti :3000

# Test HTTP response
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
# Should return 200
```

## Component Authoring

When creating component JSON files for canvas instances, ALL interactive controls (buttons, inputs, selects, etc.) must have `data-live-prompt` attributes for the canvas callback system to work.

**Pattern**: Add `data-live-prompt="<instruction for Hermes>"` to any clickable or interactive element.

**Examples**:
```html
<!-- Button with callback -->
<button class="action-btn" data-live-prompt="Delete the file: filename.pdf">Delete</button>

<!-- Input with callback -->
<input type="text" placeholder="Search..." data-live-prompt="Search downloads for the entered text">

<!-- Select with callback -->
<select data-live-prompt="Sort downloads by selected option">
  <option value="name">By Name</option>
</select>
```

**Best practices**:
- Include identifying information in the prompt (e.g., filename, item ID) so Hermes knows what to act on
- Keep prompts action-oriented: "Open the file: X", "Delete the file: Y", "Show details for Z"
- The prompt text is sent to Hermes as the user request — make it clear and specific
- For file cards or list items, add action buttons (Open, Delete, Details) each with their own `data-live-prompt`

**Verification**: After creating a component, check all interactive elements have `data-live-prompt`:
```bash
node -e "const j = require('./components/your-component.json'); console.log(j.html);" | grep -E '<button|<input|<select' | grep -v 'data-live-prompt'
# If this returns any lines, those controls are missing callbacks
```

## Frontend Prompt Scopes
The live canvas page (`index.html`) supports two distinct prompt types when submitting callbacks to the server's `POST /output` endpoint. The `scope` field is used to determine prompt type.

1. **Canvas Prompts**: Sent via the global prompt bar at the bottom of the page. Uses `submitCanvasPrompt()` which posts `{ prompt, selectedComponents }` to `/output`. Server checks `scope === 'canvas'` to identify canvas prompts (defaults to canvas if no scope provided).

2. **Component Prompts**: Triggered by elements with `data-live-prompt` attributes (e.g., buttons, inputs). Uses `submitPrompt(target, request)` which posts `{ scope: 'component', target: componentData, request: promptText }` to `/output`. Explicitly marks scope as 'component'.

**Right-click context input**: Removed in this session - user reverted the implementation to keep changes minimal and iterative.

## Server Reset Procedure
To start the server with a clean state (no pending callbacks), reset all `output.json` files in canvas instances to empty arrays before restarting:
```bash
# Find all output.json files in canvases directory
find ~/Documents/workspace/live-edit/canvases -name "output.json" -type f

# Reset each to empty array
for f in $(find ~/Documents/workspace/live-edit/canvases -name "output.json"); do
  echo '[]' > "$f"
done

# Then restart the server
kill $(lsof -ti :3000) 2>/dev/null
npm start
```

## File Shapes

`input.json`:

```json
{
  "components": [
    "/absolute/path/to/canvases/example/components~/Documents/song.mp3.component.json"
  ]
}
```

Component JSON inside the instance:

```json
{
  "file": "~/Documents/song.mp3",
  "type": "audio/mpeg",
  "html": "<audio controls data-input-file></audio>"
}
```

Use `data-input-file` where the page should insert the local server URL for that component's source file.

`output.json` (array of jobs):
```json
[
  {
    "id": "output-1746619200000-abc123",
    "scope": "canvas",
    "status": "pending",
    "createdAt": "2026-05-05T15:22:03.134Z",
    "canvasPath": "/absolute/path/to/canvas",
    "componentKey": "canvas",
    "selectedComponents": [],
    "prompt": "Make this player more compact"
  },
  {
    "id": "output-1746619300000-def456",
    "scope": "component",
    "status": "done",
    "createdAt": "2026-05-05T15:23:03.134Z",
    "completedAt": "2026-05-05T15:23:45.000Z",
    "componentPath": "/absolute/path/to/canvas/components/file.component.json",
    "componentKey": "/absolute/path/to/canvas/components/file.component.json",
    "file": "/path/to/source/file.mp3",
    "resources": {},
    "data": null,
    "target": { "componentPath": "...", "html": "...", "file": "..." },
    "prompt": "Change the volume to 50%"
  }
]
```

**Schema notes:**
- Use `scope: 'canvas'` or `scope: 'component'` to explicitly declare prompt type
- `request` field removed (duplicate of `prompt`)
- `response` field removed (not needed in output)
- `inputPath` removed (use `canvasPath` only)
- Component jobs include `target` object with full component data

## Server-to-Hermes Contract

The server supports two modes for communicating with Hermes:

### HTTP Mode (Default for New Setups)
The server sends HTTP POST requests to an external Hermes HTTP endpoint:

1. Server writes to `output.json` (array of jobs) with job details
2. `runAgentOneshot()` sends POST to `AGENT_HTTP_ENDPOINT` (default: `http://localhost:8000/chat`) with `{"message": prompt}`
3. HTTP endpoint (FastAPI plugin) calls `hermes chat -q "prompt" -Q` and returns `{"response": "..."}` 
4. Server processes the response and updates component JSON files

**Configuration**:
```javascript
const AGENT_HTTP_ENDPOINT = argValue('--agent-http-endpoint', 'http://localhost:8000/chat');
```

**HTTP Plugin Setup** (see `~/.hermes/plugins/http-agent-plugin/`):
```bash
cd ~/.hermes/plugins/http-agent-plugin
python3 -m venv .venv
.venv/bin/pip install fastapi uvicorn pydantic
.venv/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

**Benefits**: No PTY dependency, simpler debugging, Hermes runs as separate process

### PTY Mode (Legacy)
The server spawns Hermes via `node-pty` with an explicit `AGENT_PROMPT`:

1. Writes to `output.json` (an array of jobs) with: `id`, `componentPath`, `componentKey`, `prompt`, `file`, `resources`, `data`, `status`, `createdAt`
2. Invokes Hermes (via `node-pty`) which reads `output.json` from disk
3. For each pending/running callback: extracts `componentPath` and `prompt`
4. Updates the component JSON file at `componentPath` based on the prompt
5. Updates job status to `done`/`failed` in `output.json`

### HTTP Plugin Architecture

The HTTP plugin (`~/.hermes/plugins/http-agent-plugin/`) is a FastAPI server that bridges HTTP requests to Hermes CLI:

**Files**:
- `server.py` - FastAPI server with POST `/chat` endpoint
- `requirements.txt` - Dependencies (fastapi, uvicorn, pydantic)
- `README.md` - Usage instructions

**How it works**:
1. Receives `POST /chat` with `{"message": "..."}`
2. Calls `hermes chat -q "message" -Q` via `subprocess.Popen` for real-time output streaming
3. Streams Hermes CLI stdout/stderr to plugin logs with `[hermes-cli]` prefix for full visibility
4. Returns `{"response": "...", "status": "success", "session_id": "..."}` with a unique session ID for tracking

### Subagent Dispatch Alternative
Instead of spawning a new Hermes CLI instance per request, the HTTP plugin can forward requests to the main Hermes agent, which uses `delegate_task` to dispatch to subagents. This was discussed as a potential improvement (user expressed curiosity but did not request changes).

**Pros**:
- Context sharing via agent memory/user profile
- Restricted toolsets via `toolsets` parameter (e.g., `['file', 'terminal']`)
- Built-in concurrency for parallel callbacks
- No new process spawn per request
- Better error handling and retry logic

**Cons**:
- Main agent becomes a bottleneck for all incoming requests
- Subagents have restricted tool access (no `delegate_task`, `memory`, `send_message`)
- More complex architecture layer

**Current Setup**: The default implementation uses CLI spawning for simplicity and isolation. This alternative is documented for future consideration.

**Server Integration**:
```javascript
// In server.js
const AGENT_HTTP_ENDPOINT = argValue('--agent-http-endpoint', 'http://localhost:8000/chat');

const runAgentOneshot = prompt => {
    // HTTP POST to AGENT_HTTP_ENDPOINT with { message: prompt }
    // Returns parsed response.response
};
```

**Removing PTY Mode**:
When switching to HTTP mode, remove:
- `const pty = require('node-pty');`
- `AGENT_COMMAND`, `AGENT_ARGS`, `ENABLED_HERMES_TOOLSETS` variables
- `buildCanvasHermesArgs()`, `buildCanvasHermesEnv()`, `canvasHermesBootstrapPrompt()` functions
- PTY-based `startCanvasHermesHost()` and `stopCanvasHermesHost()` logic
- `activeCanvasHermes` variable

**Verification**:
```bash
# Test HTTP plugin
curl -s -X POST http://localhost:8000/chat -H "Content-Type: application/json" \
  -d '{"message": "Say hello"}'

# Should return: {"response":"Hello!...","status":"success"}
```

## Agent Prompt Optimization

**Speed prioritization**: Since Hermes output drives the UI, faster responses improve user experience. Add this guidance early in the `AGENT_PROMPT` in `server.js`:

```javascript
const AGENT_PROMPT = argValue('--agent-prompt', argValue('--hermes-prompt', [
    'You are LiquidOS, a just-in-time operating system.',
    'Prioritize speed and simple solutions unless the task is clearly complex. Your output drives the UI, so faster responses improve the user experience; avoid unnecessary reasoning for straightforward changes.',
    // ... rest of prompt
].join(' ')));
```

**Why**: UI-driven callbacks (button clicks, slider changes) should get quick responses. Hermes should default to fast/simple solutions unless the task genuinely requires deeper reasoning (complex UI layout, multi-step workflows, etc.).

**Testing before committing**: For changes that affect agent behavior (like prompt changes), test with the server running before committing. User preference: "Don't commit until I verified your changes."

## Concurrent Per-Component Job Dispatch

The server now supports concurrent callback processing via a per-component "lane" system to prevent one component's callback from blocking others.

**Key Changes:**
- `output.json` is an array of jobs (not a single job), allowing multiple pending callbacks
- File locking (`withOutputLock`, `outputLockPath`) ensures safe concurrent access to `output.json`
- `outputJobKey()` / `componentScopePath()` identifies the lane for each job (defaults to `'canvas'` for canvas-scoped jobs)
- `dispatchOutputJobs()` / `scheduleOutputDispatch()` handles async job processing, only dispatching jobs for lanes not already active
- `activeOutputKeys` Set tracks currently active lanes to prevent duplicate processing

**Plugin Requirements:**
- Plugins must include `componentKey` (matching `outputJobKey` logic) in output jobs to use dedicated lanes
- Use file locking when writing to `output.json` (matching server's `withOutputLock` pattern)
- Append to the jobs array (do not overwrite single job)

**UI Changes:**
- `index.html` now listens for `input` and `change` events (in addition to `click`) on elements with `data-live-prompt`, enabling interactive controls like sliders
- `handleLivePrompt` function centralizes prompt submission logic
- `/status` endpoint accepts `?componentPath=` query param for per-component busy state

## Plugin Callback Integration

Plugins that want to trigger Hermes callbacks (like buttons do) must write to `output.json` with the same shape as browser-submitted prompts:

**Required fields for plugin callbacks:**
```json
{
  "id": "volume-change-1234567890",
  "scope": "component",
  "status": "pending",
  "createdAt": "2026-05-07T14:00:00.000Z",
  "source": "system-volume-watch",
  "event": "system_volume_changed",
  "prompt": "Volume changed to 50%. Update volume component.",
  "componentPath": "/absolute/path/to/canvas/components/volume.component.json",
  "componentKey": "/absolute/path/to/canvas/components/volume.component.json"
}
```

**Critical**: Always include `scope: 'canvas'` or `scope: 'component'` to explicitly declare the prompt type. The server uses `scope` field to determine prompt type (canvas vs component). Also include `componentPath` and `componentKey` to let the server assign a dedicated lane. 

**Simplified server logic**:
```javascript
const isCanvasPrompt = body.scope === 'canvas';
```

Without `scope` and `componentPath`/`componentKey`, the job may block other callbacks.

**File Locking**: Match the server's `withOutputLock` pattern when writing to `output.json` to avoid concurrent write corruption. Use the `.lock` file convention: `output.json.lock`.

**Append to Array**: `output.json` is now an array of jobs. Always append new jobs (do not overwrite the entire file). Example plugin workflow:
1. Read current `output.json` (default to `[]` if invalid/empty)
2. Append new job object to the array
3. Write updated array back with file locking

**Pitfall: Plugin Coupling to Server Internals**
Plugins currently write `componentPath` and `componentKey` directly to `output.json`, coupling them to the server's dispatch internals. Ideally, plugins should only specify the target component (e.g., via a high-level `targetComponent` field) and let the server map to its internal lane system. This coupling was a pragmatic choice for initial implementation but should be refactored in future.

**Callback config pattern**: Plugins should support a config file (e.g., `~/.hermes/PLUGIN_NAME/callback.json`) that Hermes can write to without restarting the daemon. This matches how button callbacks are defined when components are created:

```json
{
  "prompt": "Volume changed to {to}%. Update the volume display.",
  "componentPath": "components/volume-display.component.json",
  "componentKey": "components/volume-display.component.json"
}
```

The server determines prompt type by `componentPath` presence, so `scope` is not needed.

The plugin reads this config each time it writes a callback, so Hermes can update the callback behavior by simply writing to the config file.

**Server logic**: The server's `outputJobKey()` function determines lane assignment as:
- `job.scope === 'canvas'` → `'canvas'`
- `job.componentKey` exists → `job.componentKey`
- `job.componentPath` exists → resolved absolute path
- Default → `'canvas'`

## On-Demand Hermes Workflow

When the user asks Hermes to handle live canvas prompts:

1. Identify the relevant canvas instance directory, then read its `output.json` directly from disk.
2. If `output.json` is empty, say there are no page prompts to handle.
3. For each callback object:
   - Read `prompt`.
   - Read `componentPath`; this is the instance-local component JSON representing the item on the page.
   - Read `file`; this is the source data or asset represented by that component.
   - Decide whether the prompt asks to change the represented data, the representation, or the input set.
4. Apply the prompt:
   - Edit the represented data/file only when the prompt clearly asks to alter the underlying data and the file type is safe to edit.
   - Edit the component JSON at `componentPath` when the prompt asks to change how the item is displayed, controlled, styled, labeled, or otherwise represented.
   - Edit the instance `input.json` when the prompt asks to add, remove, reorder, or swap represented items.
5. After handling all callbacks successfully, clear `output.json` back to `[]`.

If a prompt is ambiguous, preserve the callback in `output.json` and ask the user what it should target. Do not silently guess between editing source data and editing its representation.

Hermes does not need the server in order to process `output.json`; it only needs filesystem access to the instance JSON files and referenced paths.

## Audio/Video Processing Tips

**ffmpeg concat**: When joining audio files, the concat demuxer (`-f concat -i list.txt`) may drop streams or truncate audio. If output audio is cut short (e.g., stops at first track duration), use the concat filter instead:

```bash
ffmpeg -i file1.mp3 -i file2.mp3 -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[out]" -map "[out]" output.mp3
```

The filter properly re-encodes and merges streams, avoiding truncation issues common with the demuxer method.

## Templates

- `templates/server.js`: local bridge and input watcher for the browser.
- `templates/index.html`: canvas page with one prompt field per component.
- `templates/input.json`: manifest example.
- `templates/output.json`: empty queue.
- `templates/leaf-component.json`: component example to place inside an instance `components/` tree.
- `templates/minimal-test-canvas/`: Pre-built minimal canvas to start the server when default canvases are broken. Includes input.json, welcome component, output.json, deltas.json. Copy to `canvases/test-canvas/` and replace `/REPLACE_WITH_CANVAS_PATH` with your actual canvas path.

## Reference Scripts

- `references/create-skill-components.md`: Python script to bulk-create skill components for a hermes-skills canvas. Scans all SKILL.md files and generates component JSONs with name, description, and path.
