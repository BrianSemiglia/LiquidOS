package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// appRoot is the repo root (parent of go-server/), where agent/sidecar.js and
// skills/ live.
func appRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Dir(wd)
}

// tempWorkspace makes a minimal .liquidos workspace the sidecar can boot against.
func tempWorkspace(t *testing.T) string {
	t.Helper()
	ws := filepath.Join(t.TempDir(), "probe.liquidos")
	if err := os.MkdirAll(filepath.Join(ws, "home"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "home", "index.json"), []byte(`{"components":[]}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return ws
}

// TestBridgeNoneAgent: the default no-op agent loads, reports its identity, and
// a dispatched run rejects loudly ("No agent is configured.") — the invariant
// the smoke-test workflow relies on.
func TestBridgeNoneAgent(t *testing.T) {
	app := appRoot(t)
	ws := tempWorkspace(t)

	b, err := startAgentBridge(app, ws, "", []string{"agent/none-agent.js"}, nil)
	if err != nil {
		t.Fatalf("start bridge: %v", err)
	}
	defer b.close()

	kind, err := b.activeKind()
	if err != nil || kind != "No agent" {
		t.Fatalf("activeKind = %q, %v; want \"No agent\"", kind, err)
	}

	probe, err := b.probe()
	if err != nil || !strings.Contains(string(probe), "No agent") {
		t.Fatalf("probe = %s, %v; want it to contain \"No agent\"", probe, err)
	}

	_, runErr := b.run("do something", map[string]any{"workingDirectory": ws})
	if runErr == nil || !strings.Contains(runErr.Error(), "No agent is configured") {
		t.Fatalf("run err = %v; want \"No agent is configured.\"", runErr)
	}
}

// TestBridgeDispatch: a real test agent loads, a dispatched run streams status
// events back (sidecar -> Go), performs its file write, and resolves with its
// response string — proving both directions of the protocol end to end.
func TestBridgeDispatch(t *testing.T) {
	app := appRoot(t)
	ws := tempWorkspace(t)

	// The callback-dispatch agent writes <scope>/component.html; stage a
	// component folder and point the prompt's Scope at it.
	scope := filepath.Join(ws, "home", "components", "probe")
	if err := os.MkdirAll(scope, 0o755); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var statuses int
	onHost := func(ev hostEvent) {
		mu.Lock()
		defer mu.Unlock()
		if ev.Type == "status" {
			statuses++
		}
	}

	b, err := startAgentBridge(app, ws, "", []string{"agent/test/callback-dispatch-agent.js"}, onHost)
	if err != nil {
		t.Fatalf("start bridge: %v", err)
	}
	defer b.close()

	kind, err := b.activeKind()
	if err != nil || kind != "Callback dispatch (test)" {
		t.Fatalf("activeKind = %q, %v", kind, err)
	}

	prompt := "Scope:\n" + scope + "\n\nreact to the click"
	resp, err := b.run(prompt, map[string]any{"workingDirectory": ws, "canvasPath": filepath.Join(ws, "home")})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if resp != "ok" {
		t.Fatalf("run response = %q; want \"ok\"", resp)
	}

	// The agent's file write landed.
	html, err := os.ReadFile(filepath.Join(scope, "component.html"))
	if err != nil || !strings.Contains(string(html), "PONG") {
		t.Fatalf("component.html = %q, %v; want it to contain PONG", html, err)
	}

	// Status events streamed back over the bridge.
	mu.Lock()
	got := statuses
	mu.Unlock()
	if got == 0 {
		t.Fatalf("no status host events received; want >= 1")
	}
}
