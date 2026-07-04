package main

// timeline.go — Go port of canvas/git-timeline.js and canvas/activity-persistence.js.
//
// Every agent turn is a git commit in the workspace repo, its Event: line the
// timeline entry callers read for undo and crash recovery. The turn is
// bracketed by a will/did pair — "will" committed before the agent runs
// (snapshotting recoverable pre-state), "did" after. Even a no-disk-change turn
// commits (--allow-empty): quits, cancels, and DOM-only turns are real events.

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// git runs a git command in cwd with the LiquidOS identity; returns stdout and
// the process exit status (mirrors spawnSync's {stdout,status}).
func gitRun(cwd string, args ...string) (string, int) {
	full := append([]string{
		"-c", "user.name=LiquidOS",
		"-c", "user.email=liquidos@local",
	}, args...)
	cmd := exec.Command("git", full...)
	cmd.Dir = cwd
	out, err := cmd.Output()
	status := 0
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			status = exit.ExitCode()
		} else {
			status = 1
		}
	}
	return string(out), status
}

func quoteEventValue(value string) string {
	value = regexp.MustCompile(`[\n\r]+`).ReplaceAllString(value, " ")
	return strings.ReplaceAll(value, "'", `\'`)
}

// eventWithParameter builds a domain event label like `User did create canvas
// with name 'home'`; callers own the data model, the timeline stays ignorant.
func eventWithParameter(event, parameter, value string) string {
	if value == "" {
		return event
	}
	return event + " with " + parameter + " '" + quoteEventValue(value) + "'"
}

func willPromptEventFor(prompt string) string {
	return eventWithParameter("User will prompt", "prompt", prompt)
}

func didPromptEventFor(event, prompt string) string {
	if event != "" {
		return event
	}
	return eventWithParameter("User did prompt", "prompt", prompt)
}

func crashEvent(errText string) string { return eventWithParameter("LiquidOS did crash", "error", errText) }

func canceledEvent() string { return "User did cancel" }

func isCrashReason(reason string) bool {
	return regexp.MustCompile(`(?i)uncaught exception|unhandled rejection|crash`).MatchString(reason)
}

func shutdownEvent(reason string) string {
	if isCrashReason(reason) {
		return crashEvent(reason)
	}
	return "User did quit"
}

func workspaceName(workspacePath string) string {
	base := filepath.Base(strings.TrimRight(workspacePath, "/"))
	return strings.TrimSuffix(base, ".liquidos")
}

func commitMessage(event, scope, agentResponse string) string {
	if event == "" {
		event = "User did prompt"
	}
	if scope == "" {
		scope = "(unknown)"
	}
	if agentResponse == "" {
		agentResponse = "none"
	}
	return strings.Join([]string{"Event:", event, "", "Scope:", scope, "", "Agent Response:", agentResponse}, "\n")
}

// timelineScopeText resolves a scope for the commit's Scope: line — the canvas
// path when empty (note: no trailing separator, unlike prompt-builder's).
func timelineScopeText(scope string, currentCanvasPath func() string) string {
	value := strings.TrimSpace(scope)
	if value == "" || value == "." || value == "./" {
		return currentCanvasPath()
	}
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	return filepath.Join(currentCanvasPath(), strings.TrimPrefix(value, "./"))
}

type gitTimeline struct {
	workspacePath     string
	currentCanvasPath func() string
	logf              func(kind, msg string)
}

func newGitTimeline(workspacePath string, currentCanvasPath func() string, logf func(kind, msg string)) *gitTimeline {
	if logf == nil {
		logf = func(string, string) {}
	}
	return &gitTimeline{workspacePath: workspacePath, currentCanvasPath: currentCanvasPath, logf: logf}
}

func (t *gitTimeline) ensureWorkspaceGitRepo() error {
	os.MkdirAll(t.workspacePath, 0o755)

	top, _ := gitRun(t.workspacePath, "rev-parse", "--show-toplevel")
	topResolved, _ := filepath.Abs(strings.TrimSpace(top))
	wsResolved, _ := filepath.Abs(t.workspacePath)
	if topResolved != wsResolved {
		if _, status := gitRun(t.workspacePath, "init"); status != 0 {
			return &statusError{code: 500, msg: "Failed to initialize git repo for workspace"}
		}
	}

	if _, status := gitRun(t.workspacePath, "rev-parse", "--verify", "HEAD"); status != 0 {
		if _, s := gitRun(t.workspacePath, "add", "-A"); s != 0 {
			return &statusError{code: 500, msg: "Failed to stage initial workspace snapshot"}
		}
		msg := commitMessage(
			eventWithParameter("User did create workspace", "name", workspaceName(t.workspacePath)),
			t.workspacePath, "none")
		if _, s := gitRun(t.workspacePath, "commit", "-m", msg); s != 0 {
			return &statusError{code: 500, msg: "Failed to commit initial workspace snapshot"}
		}
	}
	return nil
}

// commitWorkspace stages the whole workspace and commits under event — even with
// no disk change (--allow-empty), since every turn is a real timeline entry.
func (t *gitTimeline) commitWorkspace(job *outputJob, event, agentResponse string) bool {
	if err := t.ensureWorkspaceGitRepo(); err != nil {
		return false
	}
	if _, status := gitRun(t.workspacePath, "add", "-A"); status != 0 {
		t.logf("git", "failed to stage workspace changes")
		return false
	}
	_, diffStatus := gitRun(t.workspacePath, "diff", "--cached", "--quiet")
	hasChanges := diffStatus != 0

	scope := ""
	if job != nil {
		scope = job.Scope
	}
	args := []string{"commit", "-m", commitMessage(event, timelineScopeText(scope, t.currentCanvasPath), orNone(agentResponse))}
	if !hasChanges {
		args = append(args, "--allow-empty")
	}
	if _, status := gitRun(t.workspacePath, args...); status != 0 {
		t.logf("git", "failed to commit workspace changes")
		return false
	}
	if hasChanges {
		t.logf("git", "committed workspace changes")
	} else {
		t.logf("git", "committed empty workspace turn")
	}
	return true
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

var eventLineRe = regexp.MustCompile(`(?:^|\n)Event:\n(.+)`)

// recentEvents returns the Event: line of each recent commit, newest first.
func (t *gitTimeline) recentEvents(limit int) []string {
	if limit <= 0 {
		limit = 50
	}
	out, status := gitRun(t.workspacePath, "log", "-n", itoa64(int64(limit)), "--format=%B%x00")
	if status != 0 {
		return nil
	}
	var events []string
	for _, block := range strings.Split(out, "\x00") {
		if m := eventLineRe.FindStringSubmatch(block); m != nil {
			if e := strings.TrimSpace(m[1]); e != "" {
				events = append(events, e)
			}
		}
	}
	return events
}

// --- activity-persistence.js ----------------------------------------------

var restoreContextRe = regexp.MustCompile(`(?s)\[\[LIQUIDOS_RESTORE_CONTEXT_BEGIN\]\](.*?)\[\[LIQUIDOS_RESTORE_CONTEXT_END\]\]`)
var threePlusNewlines = regexp.MustCompile(`\n{3,}`)

func collapseWhitespace(text string) string {
	return strings.TrimSpace(threePlusNewlines.ReplaceAllString(text, "\n\n"))
}

type activityParsed struct {
	rawAgentResponse       string
	persistedAgentResponse string
	restoreContext         []string
}

func parseActivityPersistence(text string) activityParsed {
	var blocks []string
	for _, m := range restoreContextRe.FindAllStringSubmatch(text, -1) {
		blocks = append(blocks, strings.TrimSpace(m[1]))
	}
	stripped := collapseWhitespace(restoreContextRe.ReplaceAllString(text, ""))
	return activityParsed{rawAgentResponse: text, persistedAgentResponse: stripped, restoreContext: blocks}
}

type activityPersistence struct {
	timeline *gitTimeline
}

func newActivityPersistence(workspacePath string, currentCanvasPath func() string, logf func(kind, msg string)) *activityPersistence {
	return &activityPersistence{timeline: newGitTimeline(workspacePath, currentCanvasPath, logf)}
}

// persistActivityOpts mirrors the persistActivity argument bag.
type persistActivityOpts struct {
	event, scope, prompt, agentResponse, mode, errText, reason string
}

// persistActivity commits the turn under the event chosen by mode.
func (a *activityPersistence) persistActivity(o persistActivityOpts) {
	parsed := parseActivityPersistence(o.agentResponse)
	record := &outputJob{Event: o.event, Scope: o.scope, Prompt: o.prompt}

	var eventLabel string
	switch o.mode {
	case "shutdown":
		eventLabel = shutdownEvent(o.reason)
	case "canceled":
		eventLabel = canceledEvent()
	case "failed":
		errText := o.errText
		if errText == "" {
			errText = parsed.persistedAgentResponse
		}
		eventLabel = crashEvent(errText)
	case "will":
		eventLabel = willPromptEventFor(record.Prompt)
	default:
		eventLabel = didPromptEventFor(record.Event, record.Prompt)
	}

	a.timeline.commitWorkspace(record, eventLabel, parsed.persistedAgentResponse)
}

func (a *activityPersistence) recentEvents(limit int) []string { return a.timeline.recentEvents(limit) }
