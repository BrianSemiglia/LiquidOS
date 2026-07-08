// LiquidOS server — Go port of server.js.
//
// This is the opaque, shipped core: the process the app supervises. It is a
// drop-in for `node server.js`, honoring the same CLI the launcher passes
// (--workspace, --agent…, --port, --agent-timeout-ms) and the same HTTP
// contract the canvas and the probe suite depend on. Agents stay JS behind a
// Node sidecar (see phase 3) because the tests hand the server JS agent scripts.
//
// Phase 1 (this file): CLI parity, boot on 127.0.0.1:<port>, static serving,
// /workspace file I/O, and /canvases. Later phases add the canvas engine,
// the agent sidecar bridge, spawn/kill, SSE, and go-libp2p sharing.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Configuration — parsed from argv, mirroring server.js argumentPairs().
// ---------------------------------------------------------------------------

type config struct {
	root         string // app dir (server.js ROOT = __dirname)
	workspace    string // resolved --workspace .liquidos folder
	canvasPath   string // active canvas folder (ws/home by default)
	agentScripts []string
	port         int
	agentTimeout int
}

func failStartup(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}

// parseArgs mirrors server.js: --agent is repeatable, every other flag is
// single-valued, both `--flag value` and `--flag=value` are accepted, and any
// positional or unknown flag is fatal.
func parseArgs(args []string) config {
	known := map[string]bool{"--workspace": true, "--agent": true, "--port": true, "--agent-timeout-ms": true}
	values := map[string]string{}
	var agents []string

	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "--") {
			failStartup("Unexpected positional argument: " + arg)
		}

		name := arg
		value := ""
		inline := false
		if eq := strings.Index(arg, "="); eq != -1 {
			name = arg[:eq]
			value = arg[eq+1:]
			inline = true
		} else if i+1 < len(args) {
			value = args[i+1]
		}

		if !known[name] {
			failStartup("Unknown argument: " + name)
		}
		if value == "" || strings.HasPrefix(value, "--") {
			failStartup("Missing value for " + name)
		}

		if name == "--agent" {
			agents = append(agents, value)
		} else {
			values[name] = value
		}
		if !inline {
			i++
		}
	}

	requiredArg := func(name string) string {
		v, ok := values[name]
		if !ok {
			failStartup("Missing required argument: " + name)
		}
		return v
	}

	cfg := config{agentScripts: agents}

	// ROOT: the app dir. server.js uses __dirname; when the launcher spawns us
	// via `npm start` the cwd is the app dir. LIQUIDOS_APP_ROOT overrides.
	if root := os.Getenv("LIQUIDOS_APP_ROOT"); root != "" {
		cfg.root, _ = filepath.Abs(root)
	} else {
		cfg.root, _ = os.Getwd()
	}

	cfg.workspace = resolveWorkspacePath(requiredArg("--workspace"))

	port, err := strconv.Atoi(requiredArg("--port"))
	if err != nil {
		failStartup("--port must be an integer")
	}
	cfg.port = port

	cfg.agentTimeout = 0
	if v, ok := values["--agent-timeout-ms"]; ok {
		cfg.agentTimeout, _ = strconv.Atoi(v)
	}

	if len(cfg.agentScripts) == 0 {
		failStartup("At least one --agent <script-path> is required.")
	}
	return cfg
}

// resolveWorkspacePath expands a leading ~/ and resolves to an absolute path,
// then enforces the .liquidos-folder invariant server.js checks at startup.
func resolveWorkspacePath(value string) string {
	if strings.HasPrefix(value, "~/") {
		home, _ := os.UserHomeDir()
		value = filepath.Join(home, value[2:])
	}
	abs, _ := filepath.Abs(value)
	abs = filepath.Clean(abs)

	if filepath.Ext(abs) != ".liquidos" {
		failStartup("--workspace must be a .liquidos folder")
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		failStartup("--workspace does not exist or is not a folder: " + abs)
	}
	return abs
}

// activeCanvasPath is ws/<ui-state canvas> or ws/home. server.js reads the
// `canvas` key of ui-state.json; a missing/invalid key means "home".
func activeCanvasPath(workspace string) string {
	const defaultCanvas = "home"
	name := defaultCanvas
	if data, err := os.ReadFile(filepath.Join(workspace, "ui-state.json")); err == nil {
		var state struct {
			Canvas string `json:"canvas"`
		}
		if json.Unmarshal(data, &state) == nil && state.Canvas != "" && !strings.ContainsRune(state.Canvas, '/') {
			if info, err := os.Stat(filepath.Join(workspace, state.Canvas, "index.json")); err == nil && !info.IsDir() {
				name = state.Canvas
			}
		}
	}
	return filepath.Join(workspace, name)
}

// activeAgentKind is the persisted agent selection from ui-state.json's `agent`
// key, or "" for "let the sidecar pick its default (first) runtime". Mirrors
// activeCanvasPath so a reopened workspace boots the agent the user last chose
// instead of resetting to the default.
func activeAgentKind(workspace string) string {
	if data, err := os.ReadFile(filepath.Join(workspace, "ui-state.json")); err == nil {
		var state struct {
			Agent string `json:"agent"`
		}
		if json.Unmarshal(data, &state) == nil {
			return strings.TrimSpace(state.Agent)
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// Path safety + MIME — ports of staticPath / newShapeGuardAbs / newShapeMimeFor.
// ---------------------------------------------------------------------------

// guardWorkspaceAbs resolves a /workspace/<rel> path and rejects any that
// escapes the workspace root (server.js newShapeGuardAbs).
func (c config) guardWorkspaceAbs(rel string) (string, bool) {
	cleaned := strings.TrimLeft(rel, "/")
	abs := filepath.Clean(filepath.Join(c.workspace, cleaned))
	if abs != c.workspace && !strings.HasPrefix(abs, c.workspace+string(filepath.Separator)) {
		return "", false
	}
	return abs, true
}

// staticFilePath resolves a request path to a file under ROOT, or "" if it
// escapes ROOT (server.js staticPath).
func (c config) staticFilePath(pathname string) string {
	rel := "index.html"
	if pathname != "/" {
		decoded, err := decodeURIComponent(pathname)
		if err != nil {
			return ""
		}
		rel = "." + decoded
	}
	file := filepath.Clean(filepath.Join(c.root, rel))
	if file == c.root || strings.HasPrefix(file, c.root+string(filepath.Separator)) {
		return file
	}
	return ""
}

var workspaceMime = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".png":  "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".svg": "image/svg+xml",
	".txt":  "text/plain; charset=utf-8",
	".wasm": "application/wasm",
}

func mimeFor(file string) string {
	if m, ok := workspaceMime[strings.ToLower(filepath.Ext(file))]; ok {
		return m
	}
	return "application/octet-stream"
}

// staticMime is the narrower map server.js uses for static serving (only the
// types the canvas imports); unknown extensions get no content-type.
var staticMime = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
}

// decodeURIComponent mirrors JS decodeURIComponent for path use: it unescapes
// %XX but, unlike Go's url.PathUnescape, leaves '+' literal.
func decodeURIComponent(s string) (string, error) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			hi := unhex(s[i+1])
			lo := unhex(s[i+2])
			if hi >= 0 && lo >= 0 {
				b.WriteByte(byte(hi<<4 | lo))
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String(), nil
}

func unhex(c byte) int {
	switch {
	case '0' <= c && c <= '9':
		return int(c - '0')
	case 'a' <= c && c <= 'f':
		return int(c - 'a' + 10)
	case 'A' <= c && c <= 'F':
		return int(c - 'A' + 10)
	}
	return -1
}

// ---------------------------------------------------------------------------
// Response helpers — send() sets Cache-Control: no-cache like server.js.
// ---------------------------------------------------------------------------

func send(w http.ResponseWriter, status int, body string, contentType string) {
	if contentType == "" {
		contentType = "text/plain; charset=utf-8"
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(status)
	io.WriteString(w, body)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type canvasEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Current bool   `json:"current"`
	Valid   bool   `json:"valid"`
}

// availableCanvases lists non-dotted workspace children that have an
// index.json (canvas/files.js availableCanvases).
func (c config) availableCanvases() []canvasEntry {
	out := []canvasEntry{}
	entries, err := os.ReadDir(c.workspace)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		canvasPath := filepath.Join(c.workspace, e.Name())
		if info, err := os.Stat(filepath.Join(canvasPath, "index.json")); err != nil || info.IsDir() {
			continue
		}
		out = append(out, canvasEntry{
			Name:    e.Name(),
			Path:    canvasPath,
			Current: canvasPath == c.canvasPath,
			Valid:   true,
		})
	}
	return out
}

func (c config) handleWorkspaceFile(w http.ResponseWriter, r *http.Request, rel string) {
	abs, ok := c.guardWorkspaceAbs(rel)
	if !ok {
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, "path escapes workspace")
		return
	}

	switch r.Method {
	case http.MethodGet:
		info, err := os.Stat(abs)
		if err != nil || info.IsDir() {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		// A workspace module requested under a version token is served through
		// the presentation's version graph: its relative import specifiers are
		// rewritten to carry the same token, so the whole subtree loads (and
		// re-loads) as one (server.js /workspace GET + module-graph).
		ext := strings.ToLower(filepath.Ext(abs))
		if token := r.URL.Query().Get("v"); token != "" && (ext == ".js" || ext == ".mjs") {
			data = []byte(versionImports(string(data), token))
			w.Header().Set("Content-Type", mimeFor(abs))
			w.Header().Set("Cache-Control", "no-cache")
			w.WriteHeader(http.StatusOK)
			w.Write(data)
			return
		}
		w.Header().Set("Content-Type", mimeFor(abs))
		w.WriteHeader(http.StatusOK)
		w.Write(data)

	case http.MethodHead:
		info, err := os.Stat(abs)
		if err != nil || info.IsDir() {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", mimeFor(abs))
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
		w.Header().Set("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)

	case http.MethodPut:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if err := writeFilePreservingMode(abs, body); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `{"ok":true}`)

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// writeFilePreservingMode writes atomically (tmp + rename) and carries the
// existing file's mode over, so rewriting an executable service script keeps
// its +x (server.js PUT handler).
func writeFilePreservingMode(abs string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if info, err := os.Stat(abs); err == nil {
		mode = info.Mode()
	}
	tmp := fmt.Sprintf("%s.tmp-%d-%d", abs, os.Getpid(), time.Now().UnixNano())
	if err := os.WriteFile(tmp, body, mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, abs)
}

func (c config) handleStatic(w http.ResponseWriter, r *http.Request) {
	file := c.staticFilePath(r.URL.Path)
	if file == "" {
		send(w, http.StatusNotFound, "Not found", "")
		return
	}
	// Prefer the embedded copy; fall back to disk.
	var data []byte
	rel := strings.TrimPrefix(file, c.root+string(filepath.Separator))
	if embedded, ok := embeddedClient(rel); ok {
		data = embedded
	} else {
		info, err := os.Stat(file)
		if err != nil || info.IsDir() {
			send(w, http.StatusNotFound, "Not found", "")
			return
		}
		data, err = os.ReadFile(file)
		if err != nil {
			send(w, http.StatusNotFound, "Not found", "")
			return
		}
	}
	if mime, ok := staticMime[strings.ToLower(filepath.Ext(file))]; ok {
		w.Header().Set("Content-Type", mime)
	}
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}

// appendServerLog mirrors server.js's durable log banner append.
func appendServerLog(workspace string) {
	logDir := filepath.Join(workspace, ".liquidos")
	if os.MkdirAll(logDir, 0o755) != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(logDir, "server.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "\n=== liquidos-server (Go) started pid=%d at %s workspace=%s ===\n",
		os.Getpid(), time.Now().UTC().Format(time.RFC3339), workspace)
}
