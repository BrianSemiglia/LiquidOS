package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBootstrapWorkspace(t *testing.T) {
	ws := filepath.Join(t.TempDir(), "probe.liquidos")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	appRoot := t.TempDir() // no node_modules here -> link step is a no-op

	res := bootstrapWorkspace(ws, appRoot)
	if res.err != "" {
		t.Fatalf("bootstrap error: %s", res.err)
	}
	if !res.initialized {
		t.Errorf("expected initialized=true on a fresh workspace")
	}

	// It's a git repo rooted at the workspace.
	top, status := gitRun(ws, "rev-parse", "--show-toplevel")
	if status != 0 || !samePath(strings.TrimSpace(top), ws) {
		t.Errorf("workspace is not a git repo root: %q status=%d", top, status)
	}

	// .gitignore has the runtime-managed entries.
	gi, err := os.ReadFile(filepath.Join(ws, ".gitignore"))
	if err != nil {
		t.Fatalf(".gitignore missing: %v", err)
	}
	for _, entry := range []string{"/.claude/", "/node_modules", "/AGENTS.md"} {
		if !strings.Contains(string(gi), entry) {
			t.Errorf(".gitignore missing entry %q", entry)
		}
	}

	// A HEAD commit exists.
	if _, s := gitRun(ws, "rev-parse", "--verify", "HEAD"); s != 0 {
		t.Errorf("no initial commit")
	}

	// Idempotent: a second run initializes nothing and doesn't error.
	res2 := bootstrapWorkspace(ws, appRoot)
	if res2.err != "" || res2.initialized {
		t.Errorf("second bootstrap: initialized=%v err=%q; want false, \"\"", res2.initialized, res2.err)
	}
}

func TestNodeModulesLink(t *testing.T) {
	ws := filepath.Join(t.TempDir(), "probe.liquidos")
	os.MkdirAll(ws, 0o755)
	appRoot := t.TempDir()
	os.MkdirAll(filepath.Join(appRoot, "node_modules", "playwright"), 0o755)

	ensureNodeModulesLink(ws, appRoot)

	link := filepath.Join(ws, "node_modules")
	info, err := os.Lstat(link)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected a symlink at %s: %v", link, err)
	}
	// It resolves to the app's node_modules (playwright reachable through it).
	if _, err := os.Stat(filepath.Join(link, "playwright")); err != nil {
		t.Errorf("linked node_modules does not resolve app deps: %v", err)
	}
}
