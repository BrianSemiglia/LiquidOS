package main

// server.go — the assembly. Wires the ported engine (graph, queue, timeline,
// bridge, services, stream hub, watcher) into the HTTP server that supervises a
// LiquidOS workspace, mirroring server.js's routes, dispatch loop, and crash
// recovery. /share + /network are minimal here (go-libp2p deferred).

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

type server struct {
	cfg config

	mu              sync.RWMutex
	canvasPath      string
	activeAgentKind string
	activeOutputJob *outputJob
	canceledJobIDs  map[string]bool

	bridge   *agentBridge
	queue    *outputQueue
	activity *activityPersistence
	services *serviceRegistry
	stream   *streamHub
	watcher  *fsWatcher
}

// --- state accessors ------------------------------------------------------

func (s *server) getCanvasPath() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.canvasPath
}

func (s *server) setCanvasPath(p string) {
	s.mu.Lock()
	s.canvasPath = p
	s.mu.Unlock()
}

func (s *server) currentGraph() *canvasGraph {
	return newCanvasGraph(s.getCanvasPath(), s.cfg.workspace)
}

func (s *server) canvasNameOf(p string) string {
	if rel, err := filepath.Rel(s.cfg.workspace, p); err == nil && rel != "" {
		return rel
	}
	return filepath.Base(p)
}

// absoluteScope resolves a scope to an absolute path (server.js absoluteScope).
func (s *server) absoluteScope(scope string) string {
	value := strings.TrimSpace(scope)
	canvas := s.getCanvasPath()
	if value == "" || value == "." || value == "./" {
		return canvas
	}
	if filepath.IsAbs(value) {
		return value
	}
	return filepath.Join(canvas, value)
}

func (s *server) isCanvasScope(scope string) bool {
	if scope == "" {
		return false
	}
	return s.absoluteScope(scope) == s.getCanvasPath()
}

// canvasPathFromScope: the canvas a job runs against — the first path segment
// under the workspace (server.js canvasPathFromScope).
func (s *server) canvasPathFromScope(scope string) string {
	value := strings.TrimSpace(scope)
	if value == "" {
		return s.getCanvasPath()
	}
	abs := value
	if !filepath.IsAbs(value) {
		abs = filepath.Join(s.cfg.workspace, value)
	}
	abs = filepath.Clean(abs)
	rel, err := filepath.Rel(s.cfg.workspace, abs)
	if err != nil || rel == "" || strings.HasPrefix(rel, "..") {
		return s.getCanvasPath()
	}
	return filepath.Join(s.cfg.workspace, strings.Split(rel, string(filepath.Separator))[0])
}

// --- broadcast helpers ----------------------------------------------------

func (s *server) broadcast(payload any) { s.stream.broadcastEvents(payload) }

func (s *server) queueStatePayload(componentPath string, completed any) map[string]any {
	return map[string]any{
		"type":      "queue-status",
		"state":     s.queue.currentBusyState(componentPath),
		"completed": completed,
	}
}

func (s *server) broadcastQueueState(componentPath string, completed any) {
	s.broadcast(s.queueStatePayload(componentPath, completed))
}

func shortText(value string) string {
	text := strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(value, " "))
	if len(text) > 160 {
		return text[:157] + "..."
	}
	return text
}

func newJobID() string { return "output-" + itoa64(time.Now().UnixNano()) + "-" + randomHex(3) }

// --- native app channel ---------------------------------------------------

func (s *server) emitNativeNotification(title, body string) {
	if os.Getenv("LIQUIDOS_RUNTIME_KIND") != "mac-app" {
		return
	}
	b, _ := json.Marshal(map[string]string{"title": title, "body": body})
	fmt.Printf("LIQUIDOS_NATIVE_NOTIFICATION %s\n", b)
}

// --- dispatch -------------------------------------------------------------

func (s *server) appendOutput(body []byte) error {
	var in struct {
		Scope  string `json:"scope"`
		Prompt string `json:"prompt"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return err
	}
	scope := strings.TrimSpace(in.Scope)
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" {
		return fmt.Errorf("Prompt requires prompt text")
	}
	isCanvasPrompt := scope == "" || s.currentGraph().resolveCanvasReference(scope) == s.getCanvasPath()
	jobScope := s.getCanvasPath()
	if !isCanvasPrompt {
		jobScope = s.absoluteScope(scope)
	}
	// A server-log line to stdout (server.js logServer). Besides logging, this
	// is the write that fails with EPIPE — and, on fd 1, exits the process — when
	// the app that owns our stdout force-quits and its read end goes away. That
	// clean orphan-exit is all that remains of the old crash path.
	kind := "canvas prompt"
	if !isCanvasPrompt {
		kind = "scoped prompt"
	}
	fmt.Printf("[%s] [callback] received %s scope=%s\n", nowISO(), kind, jobScope)
	s.queue.appendOutputJob(&outputJob{
		ID: newJobID(), Scope: jobScope, Status: "pending", CreatedAt: nowISO(),
		ComponentKey: jobScope, Prompt: prompt,
	})
	return nil
}

func (s *server) appendInternalOutputJob(scope, prompt, event string) {
	s.queue.appendOutputJob(&outputJob{
		ID: newJobID(), Scope: scope, Status: "pending", CreatedAt: nowISO(),
		ComponentKey: scope, Prompt: prompt, Event: event,
	})
	s.queue.feedHermesOutput()
	s.broadcastQueueState("", nil)
}

var blockedResponseRe = regexp.MustCompile(`(?i)Blocked:|error=patch rejected|not writable in this environment|writing outside of the project`)

// processOutputJob runs one queued job through the agent, bracketing it with
// will/did timeline commits (server.js processOutputJob).
func (s *server) processOutputJob(job *outputJob) {
	jobID := job.ID
	if jobID == "" {
		jobID = "job-" + itoa64(time.Now().UnixNano())
	}
	jobCanvasPath := s.canvasPathFromScope(job.Scope)
	componentPath := ""
	if job.ComponentPath != "" {
		if filepath.IsAbs(job.ComponentPath) {
			componentPath = filepath.Clean(job.ComponentPath)
		} else {
			componentPath = filepath.Join(jobCanvasPath, job.ComponentPath)
		}
	}
	laneKey := s.queue.outputJobKey(job)

	active := *job
	active.ID = jobID
	active.ComponentPath = componentPath
	s.mu.Lock()
	s.activeOutputJob = &active
	s.mu.Unlock()

	// Pre-agent snapshot.
	s.activity.persistActivity(persistActivityOpts{event: job.Event, scope: job.Scope, prompt: job.Prompt, mode: "will"})

	prompt := buildJobPrompt(job, s.getCanvasPath)
	if prepared, err := s.bridge.preparePrompt(prompt); err == nil {
		prompt = prepared
	}
	runningSummary := s.queue.outputJobSummary(&outputJob{ID: jobID, Scope: job.Scope, Status: "running", ComponentPath: componentPath, ComponentKey: job.ComponentKey, File: job.File, Prompt: job.Prompt})
	context := map[string]any{
		"job":              runningSummary,
		"canvasPath":       jobCanvasPath,
		"indexPath":        filepath.Join(jobCanvasPath, "index.json"),
		"workingDirectory": s.cfg.workspace,
		"origin":           fmt.Sprintf("http://127.0.0.1:%d", s.cfg.port),
		"systemPromptPath": s.bridge.runtimePromptPath,
	}

	agentResponse, runErr := s.bridge.run(prompt, context)

	if runErr == nil && blockedResponseRe.MatchString(agentResponse) {
		runErr = fmt.Errorf("Agent failed the live canvas write check and the test was stopped early.")
	}

	if runErr == nil {
		s.activity.persistActivity(persistActivityOpts{event: job.Event, scope: job.Scope, prompt: job.Prompt, agentResponse: agentResponse, mode: "done"})
		if err := s.currentGraph().validateCanvasConfig(); err != nil {
			// validateCanvasConfig throwing is surfaced as a failed job in JS.
		}
		s.queue.updateOutputJob(jobID, func(j *outputJob) { j.Status = "done" })
		s.broadcastQueueState("", map[string]any{"lane": laneKey, "status": "done"})
		s.emitNativeNotification("Finished", job.Prompt)
	} else {
		s.mu.Lock()
		canceled := s.canceledJobIDs[jobID]
		delete(s.canceledJobIDs, jobID)
		s.mu.Unlock()
		status := "failed"
		mode := "failed"
		if canceled {
			status = "canceled"
			mode = "canceled"
		}
		s.activity.persistActivity(persistActivityOpts{event: job.Event, scope: job.Scope, prompt: job.Prompt, agentResponse: agentResponse, mode: mode, errText: runErr.Error()})
		s.queue.updateOutputJob(jobID, func(j *outputJob) { j.Status = status })
		s.broadcastQueueState("", map[string]any{"lane": laneKey, "status": status})
		if canceled {
			s.emitNativeNotification("Canceled", job.Prompt)
		} else {
			s.emitNativeNotification("Failed", job.Prompt)
		}
	}

	s.mu.Lock()
	delete(s.canceledJobIDs, jobID)
	if s.activeOutputJob != nil && s.activeOutputJob.ID == jobID {
		s.activeOutputJob = nil
	}
	s.mu.Unlock()
}

// cancelActiveAgentJob kills the running agent's process tree so its run
// rejects; the job is then marked canceled rather than failed.
func (s *server) cancelActiveAgentJob() bool {
	s.mu.RLock()
	job := s.activeOutputJob
	s.mu.RUnlock()
	cur := s.stream.currentDebug()
	if job == nil || cur == nil || cur["status"] != "running" {
		return false
	}
	pidF, ok := cur["pid"].(float64)
	if !ok {
		return false
	}
	pid := int(pidF)
	s.mu.Lock()
	s.canceledJobIDs[job.ID] = true
	s.mu.Unlock()
	tree := append([]int{pid}, descendantsOf(pid)...)
	for _, p := range tree {
		syscall.Kill(p, syscall.SIGTERM)
	}
	afterDelay(1500, func() {
		for _, p := range append([]int{pid}, descendantsOf(pid)...) {
			syscall.Kill(p, syscall.SIGKILL)
		}
	})
	return true
}

// Crash recovery was removed: in the JS server, workspace/agent code ran
// in-process and could take the server down, so it recovered from a crash
// marker on the next boot. The Go server runs the agent in an isolated sidecar,
// so workspace content can't crash it — there is nothing to recover from.

// --- ui-state driven switches (from the watcher) --------------------------

func (s *server) uiStateFromFile() map[string]any {
	out := map[string]any{}
	if data, err := os.ReadFile(filepath.Join(s.cfg.workspace, "ui-state.json")); err == nil {
		json.Unmarshal(data, &out)
	}
	return out
}

func (s *server) applyActiveCanvasFromFile() {
	name, _ := s.uiStateFromFile()["canvas"].(string)
	if name == "" || strings.Contains(name, "/") {
		return
	}
	desired := filepath.Join(s.cfg.workspace, name)
	if s.getCanvasPath() == desired {
		return
	}
	if _, err := os.Stat(filepath.Join(desired, "index.json")); err != nil {
		return // names a missing/invalid canvas — leave current
	}
	s.setCanvasPath(desired)
	s.broadcast(map[string]any{"type": "canvases-changed"})
	s.broadcast(nil)
}

func (s *server) applyActiveAgentFromFile() {
	kind, _ := s.uiStateFromFile()["agent"].(string)
	kind = strings.TrimSpace(kind)
	s.mu.RLock()
	current := s.activeAgentKind
	s.mu.RUnlock()
	if kind == "" || kind == current {
		return
	}
	raw, err := s.bridge.selectAgent(kind)
	if err != nil {
		return
	}
	var res struct {
		OK    bool `json:"ok"`
		Agent struct {
			Kind string `json:"kind"`
		} `json:"agent"`
	}
	json.Unmarshal(raw, &res)
	if !res.OK {
		return
	}
	s.mu.Lock()
	if res.Agent.Kind != "" {
		s.activeAgentKind = res.Agent.Kind
	} else {
		s.activeAgentKind = kind
	}
	s.activeAgentKind = strings.TrimSpace(s.activeAgentKind)
	agentKind := s.activeAgentKind
	s.mu.Unlock()
	s.queue.feedHermesOutput()
	s.broadcast(map[string]any{"type": "agent-mode", "agentKind": agentKind})
}

// --- watcher event handling -----------------------------------------------

func (s *server) dispatchWorkspaceEvent(absPath string) bool {
	root := s.watcher.root
	rel, err := filepath.Rel(root, absPath)
	if err != nil {
		return false
	}
	rel = filepath.ToSlash(rel)
	if rel == "" || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return false
	}
	if rel == "ui-state.json" {
		s.applyActiveCanvasFromFile()
		s.applyActiveAgentFromFile()
		s.broadcast(map[string]any{"type": "ui-state", "state": s.uiStateFromFile()})
		return false
	}
	if !strings.Contains(rel, "/") {
		if rel != "" && !strings.HasPrefix(rel, ".") {
			s.broadcast(map[string]any{"type": "canvases-changed"})
		}
		return false
	}
	activeName := s.canvasNameOf(s.getCanvasPath())
	if activeName == "" || !strings.HasPrefix(rel, activeName+"/") {
		return false
	}
	s.broadcast(map[string]any{"type": "workspace-file", "path": rel})
	return s.currentGraph().graphDependsOn(rel)
}

func (s *server) onWatchEvents(paths []string) {
	needRefresh := false
	for _, p := range paths {
		if s.dispatchWorkspaceEvent(p) {
			needRefresh = true
		}
	}
	if needRefresh {
		s.broadcast(nil)
	}
}

func (s *server) onWatchRescan() {
	s.broadcast(map[string]any{"type": "canvases-changed"})
	s.broadcast(nil)
}

// --- HTTP -----------------------------------------------------------------

func sendJSON(w http.ResponseWriter, status int, v any) {
	b, _ := json.Marshal(v)
	send(w, status, string(b), "application/json; charset=utf-8")
}

func readBody(r *http.Request) []byte {
	data, _ := io.ReadAll(r.Body)
	return data
}

var componentFeaturesRe = regexp.MustCompile(`^/component/(.+)/features$`)

func (s *server) router() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				send(w, http.StatusInternalServerError, fmt.Sprintf("Error: %v", rec), "")
			}
		}()
		path := r.URL.Path
		method := r.Method

		switch {
		case strings.HasPrefix(path, "/workspace/"):
			rel, err := decodeURIComponent(strings.TrimPrefix(path, "/workspace/"))
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			s.cfg.handleWorkspaceFile(w, r, rel)
		case method == "GET" && path == "/events":
			s.handleEvents(w, r)
		case method == "GET" && path == "/agent/stream":
			s.handleAgentStream(w, r)
		case method == "GET" && path == "/agents/probe":
			s.handleAgentsProbe(w, r)
		case method == "GET" && path == "/input":
			sendJSON(w, 200, s.currentGraph().renderedInput())
		case method == "GET" && path == "/canvases":
			s.handleCanvasesList(w, r)
		case method == "POST" && path == "/canvases":
			s.handleCreateCanvas(w, r)
		case method == "DELETE" && strings.HasPrefix(path, "/canvases/"):
			s.handleDeleteCanvas(w, r)
		case method == "POST" && path == "/canvas/requirements":
			s.handleCanvasRequirements(w, r)
		case method == "POST" && path == "/output":
			s.handleOutputPost(w, r)
		case method == "POST" && path == "/cancel":
			s.handleCancel(w, r)
		case method == "POST" && path == "/diagnostics":
			s.handleDiagnostics(w, r)
		case method == "POST" && path == "/spawn":
			s.handleSpawn(w, r)
		case method == "POST" && path == "/kill":
			s.handleKill(w, r)
		case method == "GET" && path == "/module-closure":
			s.handleModuleClosure(w, r)
		case method == "GET" && path == "/debug/agent":
			s.handleDebugAgent(w, r)
		case method == "GET" && path == "/network/status":
			sendJSON(w, 200, map[string]any{"running": false})
		case method == "POST" && path == "/network/dial":
			send(w, 503, "network not running", "")
		case path == "/share" || strings.HasPrefix(path, "/share/"):
			s.handleShare(w, r)
		case componentFeaturesRe.MatchString(path):
			s.handleComponentFeatures(w, r)
		default:
			s.cfg.handleStatic(w, r)
		}
	})
}

func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	// Prime with the current queue state, then stream.
	go func() {
		time.Sleep(5 * time.Millisecond)
		b, _ := json.Marshal(s.queueStatePayload("", nil))
		s.stream.events.broadcast("data: " + string(b) + "\n\n")
	}()
	s.stream.events.serve(w, r)
}

func (s *server) handleAgentStream(w http.ResponseWriter, r *http.Request) {
	go func() {
		time.Sleep(5 * time.Millisecond)
		s.stream.agent.broadcast("event: debug-ready\ndata: {\"type\":\"debug-ready\"}\n\n")
		snap, _ := json.Marshal(map[string]any{"type": "debug-snapshot", "snapshot": s.agentDebugSnapshot()})
		s.stream.agent.broadcast("event: debug-snapshot\ndata: " + string(snap) + "\n\n")
	}()
	s.stream.agent.serve(w, r)
}

func (s *server) agentDebugSnapshot() map[string]any {
	probe, _ := s.bridge.probe()
	var probeObj map[string]any
	json.Unmarshal(probe, &probeObj)
	active := map[string]any{}
	if probeObj != nil {
		if a, ok := probeObj["active"].(map[string]any); ok {
			active = a
		}
	}
	return map[string]any{
		"current":   s.stream.currentDebug(),
		"lines":     s.stream.debug.snapshotLines(),
		"agentKind": s.currentAgentKind(),
		"active":    active,
	}
}

func (s *server) currentAgentKind() string {
	kind, _ := s.bridge.activeKind()
	return kind
}

func (s *server) handleAgentsProbe(w http.ResponseWriter, r *http.Request) {
	probe, err := s.bridge.probe()
	if err != nil {
		send(w, 500, err.Error(), "")
		return
	}
	send(w, 200, string(probe), "application/json; charset=utf-8")
}

func (s *server) handleCanvasesList(w http.ResponseWriter, r *http.Request) {
	canvas := s.getCanvasPath()
	c := config{root: s.cfg.root, workspace: s.cfg.workspace, canvasPath: canvas}
	sendJSON(w, 200, map[string]any{
		"current":     s.canvasNameOf(canvas),
		"currentPath": canvas,
		"canvases":    c.availableCanvases(),
	})
}

func (s *server) handleCreateCanvas(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	json.Unmarshal(readBody(r), &in)
	c := config{root: s.cfg.root, workspace: s.cfg.workspace, canvasPath: s.getCanvasPath()}
	name, err := c.createCanvas(in.Name)
	if err != nil {
		if se, ok := err.(*statusError); ok {
			send(w, se.code, se.msg, "")
			return
		}
		send(w, 500, err.Error(), "")
		return
	}
	s.activity.persistActivity(persistActivityOpts{event: didCreateCanvasEvent(name), scope: filepath.Join(s.cfg.workspace, name), agentResponse: "none", mode: "done"})
	s.broadcast(map[string]any{"type": "canvases-changed"})
	sendJSON(w, 201, map[string]any{"name": name, "canvases": c.availableCanvases()})
}

func didCreateCanvasEvent(name string) string {
	return eventWithParameter("User did create canvas", "name", name)
}

func (s *server) handleDeleteCanvas(w http.ResponseWriter, r *http.Request) {
	name, _ := decodeURIComponent(strings.TrimPrefix(r.URL.Path, "/canvases/"))
	c := config{root: s.cfg.root, workspace: s.cfg.workspace, canvasPath: s.getCanvasPath()}
	deleted, err := c.deleteCanvasWithTimeline(s.activity, name)
	if err != nil {
		if se, ok := err.(*statusError); ok {
			send(w, se.code, se.msg, "")
			return
		}
		send(w, 500, err.Error(), "")
		return
	}
	s.broadcast(map[string]any{"type": "canvases-changed"})
	sendJSON(w, 200, map[string]any{"name": deleted, "canvases": c.availableCanvases()})
}

func (s *server) handleCanvasRequirements(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Canvas string `json:"canvas"`
		Text   string `json:"text"`
	}
	if json.Unmarshal(readBody(r), &in) != nil || in.Canvas == "" {
		send(w, 400, "canvas required", "")
		return
	}
	canvasPath := filepath.Join(s.cfg.workspace, in.Canvas)
	if !pathIsInside(canvasPath, s.cfg.workspace) {
		send(w, 404, "canvas not found", "")
		return
	}
	if info, err := os.Stat(canvasPath); err != nil || !info.IsDir() {
		send(w, 404, "canvas not found", "")
		return
	}
	reqPath := filepath.Join(canvasPath, "feature-requirements.txt")
	before := ""
	if b, err := os.ReadFile(reqPath); err == nil {
		before = string(b)
	}
	after := in.Text
	changed := before != after
	if changed {
		os.WriteFile(reqPath, []byte(after), 0o644)
		s.appendInternalOutputJob(canvasPath, canvasRequirementsPrompt(in.Canvas, canvasPath, before, after), "")
	}
	sendJSON(w, 200, map[string]any{"changed": changed})
}

func (s *server) handleOutputPost(w http.ResponseWriter, r *http.Request) {
	if err := s.appendOutput(readBody(r)); err != nil {
		send(w, 400, err.Error(), "")
		return
	}
	s.queue.feedHermesOutput()
	s.broadcastQueueState("", nil)
	send(w, 204, "", "")
}

func (s *server) handleCancel(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	canceled := s.activeOutputJob
	s.mu.RUnlock()
	if canceled == nil || !s.cancelActiveAgentJob() {
		send(w, 404, "", "")
		return
	}
	undoJobID := newJobID()
	componentKey := canceled.ComponentKey
	if componentKey == "" {
		componentKey = canceled.Scope
	}
	s.queue.insertOutputJobNext(&outputJob{
		ID: undoJobID, Scope: canceled.Scope, Status: "pending", CreatedAt: nowISO(),
		ComponentKey: componentKey, Prompt: "The user canceled your previous task. Please clean up whatever you were working on.",
	})
	s.queue.feedHermesOutput()
	s.broadcastQueueState("", nil)
	sendJSON(w, 200, map[string]any{"jobId": undoJobID})
}

func (s *server) handleDiagnostics(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ComponentPath string         `json:"componentPath"`
		Category      string         `json:"category"`
		Data          map[string]any `json:"data"`
	}
	if json.Unmarshal(readBody(r), &in) != nil {
		send(w, 400, "invalid json", "")
		return
	}
	if in.ComponentPath == "" || in.Category == "" {
		send(w, 400, "componentPath and category required", "")
		return
	}
	g := s.currentGraph()
	absolute := g.resolveCanvasReference(in.ComponentPath)
	if _, err := os.Stat(absolute); err != nil {
		sendJSON(w, 200, map[string]any{"skipped": "no such component"})
		return
	}
	componentDir := componentFolderPath(absolute)
	if !pathIsInside(componentDir, s.getCanvasPath()) {
		send(w, 403, "Component outside canvas", "")
		return
	}
	if in.Data == nil {
		in.Data = map[string]any{}
	}
	g.updateDiagnostics(componentDir, in.Category, in.Data)
	s.broadcast(nil)
	send(w, 204, "", "")
}

func (s *server) handleSpawn(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Script     string            `json:"script"`
		Label      string            `json:"label"`
		DispatchID string            `json:"dispatchId"`
		Args       []string          `json:"args"`
		Env        map[string]string `json:"env"`
	}
	json.Unmarshal(readBody(r), &in)
	abs, ok := s.cfg.guardWorkspaceAbs(in.Script)
	if !ok {
		sendJSON(w, 400, map[string]any{"error": "script does not exist"})
		return
	}
	if info, err := os.Stat(abs); err != nil || info.IsDir() {
		sendJSON(w, 400, map[string]any{"error": "script does not exist"})
		return
	}
	id, pid := s.services.spawnService(abs, in.Label, in.DispatchID, in.Args, in.Env)
	if id == "" {
		sendJSON(w, 500, map[string]any{"error": "spawn failed"})
		return
	}
	sendJSON(w, 200, map[string]any{"id": id, "pid": pid, "dispatchId": in.DispatchID})
}

func (s *server) handleKill(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID string `json:"id"`
	}
	json.Unmarshal(readBody(r), &in)
	ok := s.services.killService(in.ID)
	status := 200
	if !ok {
		status = 404
	}
	sendJSON(w, status, map[string]any{"ok": ok})
}

func (s *server) handleModuleClosure(w http.ResponseWriter, r *http.Request) {
	abs, ok := s.cfg.guardWorkspaceAbs(r.URL.Query().Get("path"))
	files := []string{}
	if ok {
		for f := range closure(abs) {
			rel, _ := filepath.Rel(s.cfg.workspace, f)
			files = append(files, filepath.ToSlash(rel))
		}
	}
	sendJSON(w, 200, files)
}

func (s *server) handleDebugAgent(w http.ResponseWriter, r *http.Request) {
	snap := s.agentDebugSnapshot()
	snap["canvas"] = s.canvasNameOf(s.getCanvasPath())
	sendJSON(w, 200, snap)
}

func (s *server) handleComponentFeatures(w http.ResponseWriter, r *http.Request) {
	m := componentFeaturesRe.FindStringSubmatch(r.URL.Path)
	componentPath, _ := decodeURIComponent(m[1])
	g := s.currentGraph()
	entry := g.findLeafComponentByPath(componentPath)
	if entry == nil {
		send(w, 404, "Component not found", "")
		return
	}
	if r.Method != "POST" {
		send(w, 405, "", "")
		return
	}
	var in struct {
		Text string `json:"text"`
	}
	json.Unmarshal(readBody(r), &in)
	featFile := filepath.Join(componentFolderPath(entry.componentPath), "feature-requirements.txt")
	before := ""
	if b, err := os.ReadFile(featFile); err == nil {
		before = string(b)
	}
	after := in.Text
	changed := before != after
	if changed {
		os.MkdirAll(filepath.Dir(featFile), 0o755)
		os.WriteFile(featFile, []byte(after), 0o644)
		s.appendInternalOutputJob(componentFolderPath(entry.componentPath), componentFeaturePrompt(g.componentScopePath(entry.componentPath), before, after), "")
	}
	sendJSON(w, 200, map[string]any{"changed": changed})
}

// handleShare is minimal: report per-canvas share state from share.json; the
// go-libp2p networking is deferred, so it never joins the DHT.
func (s *server) handleShare(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" && r.URL.Path == "/share" {
		shared := false
		if b, err := os.ReadFile(filepath.Join(s.getCanvasPath(), "share.json")); err == nil {
			var sj struct {
				Shared bool `json:"shared"`
			}
			json.Unmarshal(b, &sj)
			shared = sj.Shared
		}
		sendJSON(w, 200, map[string]any{"shared": shared})
		return
	}
	send(w, 501, "sharing not available in this build", "")
}

// --- prompts (server.js) --------------------------------------------------

func componentFeaturePrompt(componentScope, before, after string) string {
	if before == "" {
		before = "(none)"
	}
	if after == "" {
		after = "(none)"
	}
	return strings.Join([]string{
		"The user edited the feature requirements for this component.", "",
		"Component:", componentScope, "",
		"Previous requirements:", before, "",
		"Updated requirements:", after, "",
		"Review the actual component before changing anything.",
		`Keep feature-requirements.txt user-facing, concise, plain-language, and faithful to what the component does or is meant to do. It is a plain text file with no title — the title comes from view.json. One requirement per line, each line a bullet beginning with "- ".`,
		"If the requirements and implementation disagree, resolve the mismatch by updating the implementation, the requirements, or both, based on the user's intent.",
		"Do not add unrelated capabilities or preserve inaccurate requirements.",
	}, "\n")
}

func canvasRequirementsPrompt(canvasName, canvasScope, before, after string) string {
	if before == "" {
		before = "(none)"
	}
	if after == "" {
		after = "(none)"
	}
	return strings.Join([]string{
		"The user edited the requirements for this canvas.", "",
		"Canvas:", canvasName, "",
		"Previous requirements:", before, "",
		"Updated requirements:", after, "",
		"Reconcile the canvas to match the updated requirements:",
		"- Add, remove, or modify components in index.json as the prose dictates.",
		"- Add, remove, or modify relationships under " + canvasScope + "/relationships/ (see skills/relationships).",
		"- Update individual components' feature-requirements.txt files when canvas-level intent changes their roles.",
		`Keep feature-requirements.txt user-facing, plain-language, and faithful to what the canvas is for. Write the requirements as bullets, each line beginning with "- ".`,
		"If the requirements and the actual canvas disagree, resolve the mismatch based on the user's intent.",
	}, "\n")
}

// --- startup --------------------------------------------------------------

func (s *server) run() error {
	// Reap strays a crashed prior server left behind before spawning fresh.
	reapStrayWorkspaceProcesses(s.cfg.workspace)

	// Bootstrap the workspace git repo + gitignore + node_modules link.
	if res := bootstrapWorkspace(s.cfg.workspace, s.cfg.root); res.err != "" {
		fmt.Fprintf(os.Stderr, "[workspace-bootstrap] failed: %s\n", res.err)
	}

	s.stream = newStreamHub()
	s.services = newServiceRegistry(s.cfg.workspace, func(line string) { fmt.Println(line) })
	s.services.dropSource = s.stream.dropSniffer
	s.activity = newActivityPersistence(s.cfg.workspace, s.getCanvasPath, nil)

	// Ensure the default canvas exists.
	c := config{root: s.cfg.root, workspace: s.cfg.workspace, canvasPath: s.getCanvasPath()}
	if _, err := c.ensureCanvasDefaults("home"); err != nil {
		return err
	}

	// Start the agent sidecar bridge, routing host events to the stream hub.
	onHost := func(ev hostEvent) {
		switch ev.Type {
		case "output":
			s.stream.serializeProducerChunk(agentSource, ev.Chunk)
			s.stream.writeProcessOutput(ev.Label, ev.Chunk)
		case "status":
			var debug map[string]any
			if json.Unmarshal(ev.Debug, &debug) == nil {
				s.stream.setCurrentAgentDebug(debug)
			}
		}
	}
	bridge, err := startAgentBridge(s.cfg.root, s.cfg.workspace, s.activeAgentKind, s.cfg.agentScripts, onHost)
	if err != nil {
		return fmt.Errorf("agent bridge: %w", err)
	}
	s.bridge = bridge
	s.activeAgentKind = bridge.selection

	// The queue, wired to the dispatch processor (with the recovery chain).
	s.queue = newOutputQueue(queueDeps{
		workspacePath:          s.cfg.root,
		getCanvasPath:          s.getCanvasPath,
		resolveCanvasReference: func(v string) string { return s.currentGraph().resolveCanvasReference(v) },
		isCanvasScope:          s.isCanvasScope,
		shortText:              shortText,
		logf:                   func(kind, msg string) {},
	})
	s.queue.setProcessJob(s.processOutputJob)

	// The workspace watcher.
	watcher, err := newFSWatcher(s.cfg.workspace, []string{"node_modules", ".git", ".liquidos"}, s.onWatchEvents, s.onWatchRescan)
	if err != nil {
		return fmt.Errorf("watcher: %w", err)
	}
	s.watcher = watcher

	// Clean shutdown: kill our whole subtree.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		killOwnSubtree()
		os.Exit(0)
	}()

	// Force-quit path: the app that owns our stdout vanishes (uncatchable
	// SIGKILL), so it never runs a clean shutdown; our next stdout write hits a
	// readerless pipe. By default Go would terminate on SIGPIPE for fd 1/2
	// silently — instead we catch it, note the EPIPE on stderr (still readable),
	// and exit cleanly. This is orphan cleanup, NOT a crash: no marker is
	// written (crash recovery was removed), so no phantom recovery next launch.
	pipe := make(chan os.Signal, 1)
	signal.Notify(pipe, syscall.SIGPIPE)
	go func() {
		<-pipe
		fmt.Fprintln(os.Stderr, "EPIPE: stdout reader went away (app force-quit); exiting")
		killOwnSubtree()
		os.Exit(0)
	}()

	// Bind first so we can report the actual port: --port 0 asks the OS for an
	// ephemeral one, and callers (e.g. the force-quit probe) read the resolved
	// port from this line, exactly as server.js does via server.address().port.
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.cfg.port))
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	resolvedPort := listener.Addr().(*net.TCPAddr).Port

	fmt.Printf("Server at http://127.0.0.1:%d\n", resolvedPort)
	fmt.Println("Canvas: " + s.getCanvasPath())

	return http.Serve(listener, s.router())
}

func main() {
	// Subcommands let the agent's shell tooling reach server logic through the
	// one binary instead of a JS module, so no server-logic JS needs to ship.
	if len(os.Args) > 1 && os.Args[1] == "delete-canvas" {
		runDeleteCanvasCLI(os.Args[2:])
		return
	}

	cfg := parseArgs(os.Args[1:])
	cfg.canvasPath = activeCanvasPath(cfg.workspace)
	appendServerLog(cfg.workspace)

	s := &server{
		cfg:             cfg,
		canvasPath:      cfg.canvasPath,
		activeAgentKind: activeAgentKind(cfg.workspace),
		canceledJobIDs:  map[string]bool{},
	}
	if err := s.run(); err != nil {
		failStartup("server failed: " + err.Error())
	}
}
