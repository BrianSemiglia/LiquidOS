package main

// dispatch.go — Go port of canvas/output-queue.js and canvas/prompt-builder.js.
//
// The output queue is in-memory, per-canvas job state with a SINGLE-LANE serial
// dispatcher: at most one job runs at a time (JS gates via activeOutputKeys; a
// pending job only dispatches when no lane is active). Not persisted — a crash
// drops pending work and a canvas switch resets it. The JS timer/setImmediate
// choreography is replaced by a dispatcher goroutine woken over a channel.

import (
	"path/filepath"
	"strings"
	"sync"
)

// outputJob mirrors the flexible job bag server.js enqueues. Only the fields the
// queue and processor read are modeled; unknown keys aren't needed.
type outputJob struct {
	ID            string `json:"id,omitempty"`
	Scope         string `json:"scope,omitempty"`
	Status        string `json:"status,omitempty"`
	CreatedAt     string `json:"createdAt,omitempty"`
	ComponentKey  string `json:"componentKey,omitempty"`
	ComponentPath string `json:"componentPath,omitempty"`
	File          string `json:"file,omitempty"`
	Prompt        string `json:"prompt,omitempty"`
	Event         string `json:"event,omitempty"`
	Target        *struct {
		ComponentPath string `json:"componentPath,omitempty"`
	} `json:"target,omitempty"`
}

func callbackPromptText(job *outputJob) string {
	if job == nil {
		return ""
	}
	return job.Prompt
}

// queueDeps are the host hooks the queue needs (server.js injects these).
type queueDeps struct {
	workspacePath          string // server.js passes ROOT here
	getCanvasPath          func() string
	resolveCanvasReference func(string) string
	isCanvasScope          func(string) bool
	shortText              func(string) string
	logf                   func(kind, msg string) // best-effort logging
}

type outputQueue struct {
	deps queueDeps

	mu         sync.Mutex
	jobs       []*outputJob
	laneActive bool // at most one lane runs at a time
	processJob func(*outputJob)

	wake   chan struct{}
	closed chan struct{}
	once   sync.Once
}

type jobSummary struct {
	ID            string `json:"id"`
	Status        string `json:"status"`
	Lane          string `json:"lane"`
	Scope         string `json:"scope"`
	ComponentPath string `json:"componentPath"`
	File          string `json:"file"`
	Prompt        string `json:"prompt"`
}

func newOutputQueue(deps queueDeps) *outputQueue {
	q := &outputQueue{
		deps:   deps,
		wake:   make(chan struct{}, 1),
		closed: make(chan struct{}),
	}
	go q.dispatchLoop()
	return q
}

func (q *outputQueue) resolveFromWorkspacePath(value string) string {
	if filepath.IsAbs(value) {
		return value
	}
	return filepath.Join(q.deps.workspacePath, value)
}

// outputJobKey is the lane a job runs on: "canvas" for canvas-scoped work, else
// the resolved component identity, else its file, else "canvas".
func (q *outputQueue) outputJobKey(job *outputJob) string {
	if job == nil {
		return ""
	}
	if q.deps.isCanvasScope(job.Scope) {
		return "canvas"
	}
	if strings.TrimSpace(job.ComponentKey) != "" {
		return strings.TrimSpace(job.ComponentKey)
	}
	if strings.TrimSpace(job.ComponentPath) != "" {
		return q.deps.resolveCanvasReference(job.ComponentPath)
	}
	if job.Target != nil && strings.TrimSpace(job.Target.ComponentPath) != "" {
		return q.deps.resolveCanvasReference(job.Target.ComponentPath)
	}
	if strings.TrimSpace(job.File) != "" {
		return q.resolveFromWorkspacePath(job.File)
	}
	return "canvas"
}

func (q *outputQueue) outputJobSummary(job *outputJob) jobSummary {
	if job == nil {
		return jobSummary{}
	}
	return jobSummary{
		ID:            job.ID,
		Status:        job.Status,
		Lane:          q.outputJobKey(job),
		Scope:         job.Scope,
		ComponentPath: job.ComponentPath,
		File:          job.File,
		Prompt:        q.deps.shortText(callbackPromptText(job)),
	}
}

func (q *outputQueue) appendOutputJob(job *outputJob) {
	q.mu.Lock()
	q.jobs = append(q.jobs, job)
	q.mu.Unlock()
}

// insertOutputJobNext jumps a job ahead of any already-pending work (used by the
// cancel cleanup), leaving a running job its slot.
func (q *outputQueue) insertOutputJobNext(job *outputJob) {
	q.mu.Lock()
	idx := -1
	for i, j := range q.jobs {
		if j != nil && j.Status == "pending" {
			idx = i
			break
		}
	}
	if idx == -1 {
		q.jobs = append(q.jobs, job)
	} else {
		q.jobs = append(q.jobs[:idx], append([]*outputJob{job}, q.jobs[idx:]...)...)
	}
	q.mu.Unlock()
}

func (q *outputQueue) updateOutputJob(jobID string, patch func(*outputJob)) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	updated := false
	for _, j := range q.jobs {
		if j.ID == jobID {
			patch(j)
			updated = true
		}
	}
	return updated
}

func (q *outputQueue) activeOutputJobs() []*outputJob {
	var out []*outputJob
	for _, j := range q.jobs {
		if (j.Status == "pending" || j.Status == "running") && callbackPromptText(j) != "" {
			out = append(out, j)
		}
	}
	return out
}

// currentBusyState reports whether a lane (or the whole queue) is busy — the
// payload the client renders as the per-component/canvas spinner.
func (q *outputQueue) currentBusyState(key string) map[string]any {
	q.mu.Lock()
	defer q.mu.Unlock()
	active := q.activeOutputJobs()
	componentKey := strings.TrimSpace(key)
	var filtered []*outputJob
	if componentKey != "" {
		for _, j := range active {
			if q.deps.isCanvasScope(j.Scope) || q.outputJobKey(j) == componentKey {
				filtered = append(filtered, j)
			}
		}
	} else {
		filtered = active
	}
	var job *outputJob
	if len(filtered) > 0 {
		job = filtered[len(filtered)-1]
	} else if len(active) > 0 {
		job = active[len(active)-1]
	}
	summaries := make([]jobSummary, 0, len(filtered))
	for _, j := range filtered {
		summaries = append(summaries, q.outputJobSummary(j))
	}
	var jobPayload any
	if job != nil {
		jobPayload = q.outputJobSummary(job)
	}
	return map[string]any{
		"busy": len(filtered) > 0,
		"job":  jobPayload,
		"jobs": summaries,
	}
}

func (q *outputQueue) setProcessJob(fn func(*outputJob)) { q.processJob = fn }

// feedHermesOutput requests a dispatch pass (server.js scheduleOutputDispatch).
func (q *outputQueue) feedHermesOutput() {
	select {
	case q.wake <- struct{}{}:
	default: // a pass is already pending
	}
}

func (q *outputQueue) clearActiveLanes() {
	q.mu.Lock()
	q.laneActive = false
	q.mu.Unlock()
}

// dispatchLoop is the single dispatcher: on each wake, if no lane is active and
// a pending job exists, it reserves the lane and runs exactly that one job, then
// re-wakes when it finishes — a serial queue, matching output-queue.js.
func (q *outputQueue) dispatchLoop() {
	for {
		select {
		case <-q.closed:
			return
		case <-q.wake:
		}

		q.mu.Lock()
		if q.laneActive {
			q.mu.Unlock()
			continue
		}
		var next *outputJob
		for _, j := range q.jobs {
			if j.Status == "pending" && callbackPromptText(j) != "" {
				next = j
				break
			}
		}
		if next == nil || q.processJob == nil {
			q.mu.Unlock()
			continue
		}
		q.laneActive = true
		fn := q.processJob
		q.mu.Unlock()

		go func(job *outputJob) {
			defer func() {
				recover() // a processor panic must still release the lane
				q.mu.Lock()
				q.laneActive = false
				q.mu.Unlock()
				q.feedHermesOutput() // dispatch the next pending job
			}()
			fn(job)
		}(next)
	}
}

func (q *outputQueue) close() {
	q.once.Do(func() { close(q.closed) })
}

// --- prompt-builder.js ----------------------------------------------------

// scopeText resolves a job scope to a directory-ish path string for the prompt:
// the canvas root (trailing sep) when empty/dot, else the resolved path.
func scopeText(scope string, getCanvasPath func() string) string {
	value := strings.TrimSpace(scope)
	asDir := func(file string) string {
		if strings.HasSuffix(file, string(filepath.Separator)) {
			return file
		}
		return file + string(filepath.Separator)
	}
	canvasPath := getCanvasPath()
	if value == "" || value == "." || value == "./" {
		return asDir(canvasPath)
	}
	var resolved string
	if filepath.IsAbs(value) {
		resolved = filepath.Clean(value)
	} else {
		resolved = filepath.Join(canvasPath, strings.TrimPrefix(value, "./"))
	}
	if resolved == canvasPath {
		return asDir(resolved)
	}
	return resolved
}

// buildJobPrompt is the per-job prompt: Scope + Prompt only. Standing guidance
// lives in AGENTS.md (prompt-builder.js buildJobPrompt).
func buildJobPrompt(job *outputJob, getCanvasPath func() string) string {
	return strings.Join([]string{
		"Scope:",
		scopeText(job.Scope, getCanvasPath),
		"",
		"Prompt:",
		callbackPromptText(job),
	}, "\n")
}
