package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestServiceHelpers(t *testing.T) {
	// dispatchLabelFor: strips a trailing filename to name after its folder.
	if got := dispatchLabelFor("components/clock/service.js"); got != "clock" {
		t.Errorf("dispatchLabelFor = %q; want clock", got)
	}
	if got := dispatchLabelFor("widget"); got != "widget" {
		t.Errorf("dispatchLabelFor = %q; want widget", got)
	}
	if got := safeName("a/b c!"); got != "a_b_c_" {
		t.Errorf("safeName = %q", got)
	}
}

// TestSpawnAndKillService spawns a long-running script, confirms it's tracked
// and alive, then kills it and confirms the process is gone.
func TestSpawnAndKillService(t *testing.T) {
	dir := t.TempDir()
	// A script that records its dispatch id then sleeps, so we can see it ran
	// with the expected argv and env, and that killing it stops it.
	script := filepath.Join(dir, "service.sh")
	marker := filepath.Join(dir, "started")
	body := "#!/bin/sh\necho \"$1 $LIQUIDOS_DISPATCH_ID\" > " + marker + "\nsleep 30\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}

	reg := newServiceRegistry(dir, func(string) {})
	id, pid := reg.spawnService(script, "components/foo/service.sh", "", nil, nil)
	if id == "" || pid == 0 {
		t.Fatalf("spawn failed: id=%q pid=%d", id, pid)
	}

	// It ran with the dispatch id as argv[1] and in the env.
	waitFor(t, func() bool {
		data, err := os.ReadFile(marker)
		return err == nil && strings.Contains(string(data), "-") // dispatch id like "foo-abcd"
	}, "service did not start")

	data, _ := os.ReadFile(marker)
	parts := strings.Fields(strings.TrimSpace(string(data)))
	if len(parts) != 2 || parts[0] != parts[1] {
		t.Errorf("argv/env dispatch id mismatch: %q", data)
	}

	// Process is alive.
	if !processAlive(pid) {
		t.Fatalf("service pid %d not alive", pid)
	}

	if !reg.killService(id) {
		t.Fatalf("killService returned false")
	}
	waitFor(t, func() bool { return !processAlive(pid) }, "service was not killed")
	_ = reg.workspacePath
}

func waitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal(msg)
}

func processAlive(pid int) bool {
	// signal 0 probes existence without killing.
	return syscall.Kill(pid, 0) == nil
}
