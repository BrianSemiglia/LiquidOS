package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestFSWatcherDetectsChanges(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "home", "components"), 0o755)
	os.MkdirAll(filepath.Join(root, "node_modules", "x"), 0o755) // ignored tree

	var mu sync.Mutex
	seen := map[string]bool{}
	w, err := newFSWatcher(root, []string{"node_modules", ".git", ".liquidos"}, func(paths []string) {
		mu.Lock()
		for _, p := range paths {
			rel, _ := filepath.Rel(mustEval(root), p)
			seen[filepath.ToSlash(rel)] = true
		}
		mu.Unlock()
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer w.close()
	time.Sleep(50 * time.Millisecond) // let the watch establish

	// A write inside the workspace is reported.
	os.WriteFile(filepath.Join(root, "home", "index.json"), []byte(`{"components":[]}`), 0o644)
	// A brand-new nested dir + file (exercises recursive add).
	os.MkdirAll(filepath.Join(root, "home", "components", "foo"), 0o755)
	time.Sleep(60 * time.Millisecond)
	os.WriteFile(filepath.Join(root, "home", "components", "foo", "component.html"), []byte("<x/>"), 0o644)
	// A write inside an ignored tree must NOT be reported.
	os.WriteFile(filepath.Join(root, "node_modules", "x", "pkg.js"), []byte("//"), 0o644)

	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return seen["home/index.json"] && seen["home/components/foo/component.html"]
	}, "expected workspace changes to be reported")

	mu.Lock()
	defer mu.Unlock()
	for p := range seen {
		if strings.HasPrefix(p, "node_modules") {
			t.Errorf("ignored tree reported: %s", p)
		}
	}
}

func mustEval(p string) string {
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	return p
}
