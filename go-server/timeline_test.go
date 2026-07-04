package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestActivityTimelineEndToEnd(t *testing.T) {
	ws := filepath.Join(t.TempDir(), "probe.liquidos")
	canvas := filepath.Join(ws, "home")
	if err := os.MkdirAll(canvas, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(canvas, "index.json"), []byte(`{"components":[]}`), 0o644)

	ap := newActivityPersistence(ws, func() string { return canvas }, nil)

	// A will/did bracket around a turn, then a cancel.
	ap.persistActivity(persistActivityOpts{scope: canvas, prompt: "add a clock", mode: "will"})
	os.WriteFile(filepath.Join(canvas, "clock.txt"), []byte("tick"), 0o644) // the "agent" changed a file
	ap.persistActivity(persistActivityOpts{scope: canvas, prompt: "add a clock", agentResponse: "done", mode: "done"})
	ap.persistActivity(persistActivityOpts{scope: canvas, mode: "canceled"})

	events := ap.recentEvents(10)
	// Newest first: cancel, did, will, then the initial workspace-create commit.
	want := []string{
		"User did cancel",
		"User did prompt with prompt 'add a clock'",
		"User will prompt with prompt 'add a clock'",
		"User did create workspace with name 'probe'",
	}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("recentEvents =\n%#v\nwant\n%#v", events, want)
	}
}

func TestParseActivityRestoreContext(t *testing.T) {
	text := "Here is the answer.\n\n[[LIQUIDOS_RESTORE_CONTEXT_BEGIN]]\nremember: X\n[[LIQUIDOS_RESTORE_CONTEXT_END]]\n\n\n\nmore body."
	p := parseActivityPersistence(text)
	if len(p.restoreContext) != 1 || p.restoreContext[0] != "remember: X" {
		t.Errorf("restoreContext = %#v", p.restoreContext)
	}
	want := "Here is the answer.\n\nmore body."
	if p.persistedAgentResponse != want {
		t.Errorf("persisted = %q; want %q", p.persistedAgentResponse, want)
	}
}

func TestEventWithParameter(t *testing.T) {
	if got := eventWithParameter("User did create canvas", "name", "home"); got != "User did create canvas with name 'home'" {
		t.Errorf("got %q", got)
	}
	// Newlines collapse and quotes escape.
	if got := eventWithParameter("E", "prompt", "a\nb 'c'"); got != `E with prompt 'a b \'c\''` {
		t.Errorf("got %q", got)
	}
	// No value -> bare event.
	if got := eventWithParameter("E", "p", ""); got != "E" {
		t.Errorf("got %q", got)
	}
}
