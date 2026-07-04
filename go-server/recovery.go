package main

// recovery.go — Go port of canvas/crash-recovery.js.
//
// When the server dies on an uncaught exception, something the agent built took
// it down. The harness doesn't guess the fix: recovery is two agent dispatches
// on normal boots. Phase 1 (make it bootable) leaves a RECOVER_EVENT commit that
// owes Phase 2 (make it permanent). Phase 2 is owed whenever the latest crash
// recovery hasn't yet been followed by a permanent-fix attempt — read straight
// off the git timeline, no extra state. The marker is a dotfile so the canvas
// walkers never treat it as a canvas.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const crashMarkerFile = ".crash-report.json"

// The events committed per phase — the contract permanentFixOwed scans for.
const recoverEvent = "LiquidOS did recover from crash"
const fixEvent = "LiquidOS did attempt a permanent fix"

func crashMarkerPath(workspacePath string) string {
	return filepath.Join(workspacePath, crashMarkerFile)
}

type crashReport struct {
	Reason string `json:"reason"`
	Stack  string `json:"stack"`
}

// writeCrashReport lands the marker before the process exits.
func writeCrashReport(workspacePath, reason, stack string) {
	data, err := json.MarshalIndent(crashReport{Reason: reason, Stack: stack}, "", "  ")
	if err != nil {
		return
	}
	os.WriteFile(crashMarkerPath(workspacePath), data, 0o644)
}

// consumeCrashReport reads and removes the marker; ok is false when absent.
func consumeCrashReport(workspacePath string) (crashReport, bool) {
	file := crashMarkerPath(workspacePath)
	data, err := os.ReadFile(file)
	if err != nil {
		return crashReport{}, false
	}
	os.Remove(file)
	var report crashReport
	if json.Unmarshal(data, &report) != nil {
		return crashReport{}, false
	}
	return report, true
}

// permanentFixOwed: walking newest-first, a fix is owed when the most recent
// crash recovery has not yet been followed by a permanent-fix attempt.
func permanentFixOwed(events []string) bool {
	for _, event := range events {
		if event == fixEvent {
			return false
		}
		if event == recoverEvent {
			return true
		}
	}
	return false
}

func crashRepairPrompt(reason, stack string) string {
	if reason == "" {
		reason = "(no message)"
	}
	stack = strings.TrimSpace(stack)
	if stack == "" {
		stack = "(none)"
	}
	return `The LiquidOS server just crashed and was restarted. Something in this
workspace took the whole server down.

Right now your only job is to get the server booting again. Make the
smallest, most transitory change that stops the crash — disable or stub
whatever is taking the server down so the rest of the workspace can run.
This is not the real fix: once the server is back up a follow-up will try
to fix it properly. Keep your change minimal and easy to undo.

This may not be your first attempt. Check ` + "`git log`" + ` for previous
"LiquidOS did recover from crash" commits and the diffs they made — that
is where earlier attempts left their reasoning. Read it so you don't
repeat a fix that did not work. If the crash continues the server will
restart and ask you again.

Error:
` + reason + `

Stack:
` + stack
}

func permanentFixPrompt() string {
	return `The LiquidOS server crashed earlier and was made bootable with a minimal,
transitory change — it is running now. Make a permanent fix for the
underlying cause, then undo the transitory change so the workspace is whole
again.

You must do this in a sandbox: a bad fix would crash the live server again,
so reproduce the crash and prove the fix in a sandbox before you touch the
live workspace. See the ` + "`testing`" + ` skill for how to boot a workspace sandbox.
Only once the fix holds in the sandbox: apply it to the live workspace and
undo the transitory change. If you cannot make it safe, leave the transitory
change in place.

Check ` + "`git log`" + ` for the "LiquidOS did recover from crash" commit and its
diff to see what was changed and why, and for any earlier permanent-fix
attempts so you do not repeat one that did not work.`
}
