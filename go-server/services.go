package main

// services.go — Go port of server.js's component-service process management.
//
// A component with a <liquidos-file run> element has its script spawned as a
// detached process (the client POSTs /spawn). A service has no view channel: it
// changes the UI by writing its own files, which the watcher morphs in — the
// same path the agent's writes take. Its stdout/stderr are ordinary server logs.
// On shutdown / next boot we kill our whole descendant tree and reap strays a
// crashed prior server left re-parented to launchd.

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// afterDelay runs fn after ms milliseconds (setTimeout equivalent).
func afterDelay(ms int, fn func()) *time.Timer {
	return time.AfterFunc(time.Duration(ms)*time.Millisecond, fn)
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

type service struct {
	cmd        *exec.Cmd
	label      string
	dispatchID string
	abs        string
	source     string
}

type serviceRegistry struct {
	mu            sync.Mutex
	services      map[string]*service
	workspacePath string
	logf          func(line string)
	// dropSource lets the registry clear a producer's sniffer on kill (server.js
	// serverSniffers.delete). Optional.
	dropSource func(source string)
}

func newServiceRegistry(workspacePath string, logf func(string)) *serviceRegistry {
	if logf == nil {
		logf = func(string) {}
	}
	return &serviceRegistry{services: map[string]*service{}, workspacePath: workspacePath, logf: logf}
}

func newServiceID() string  { return "svc_" + randomHex(6) }
func dispatchLabelFor(label string) string {
	s := label
	if s == "" {
		s = "service"
	}
	parts := []string{}
	for _, p := range strings.Split(s, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) >= 2 && strings.Contains(parts[len(parts)-1], ".") {
		return parts[len(parts)-2]
	}
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return "service"
}

var nonSafeName = regexp.MustCompile(`[^a-zA-Z0-9._-]`)

func safeName(s string) string {
	if s == "" {
		s = "service"
	}
	s = nonSafeName.ReplaceAllString(s, "_")
	if len(s) > 40 {
		s = s[:40]
	}
	if s == "" {
		return "service"
	}
	return s
}

func newDispatchID(label string) string {
	return safeName(dispatchLabelFor(label)) + "-" + randomHex(2)
}

// descendantsOf returns all transitive child pids of pid (via pgrep -P).
func descendantsOf(pid int) []int {
	out, err := exec.Command("pgrep", "-P", strconv.Itoa(pid)).Output()
	if err != nil {
		return nil
	}
	var all []int
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		child, err := strconv.Atoi(line)
		if err != nil {
			continue
		}
		all = append(all, child)
		all = append(all, descendantsOf(child)...)
	}
	return all
}

// killOwnSubtree SIGKILLs everything this server spawned (services, agent
// sidecar, and their children), by walking our own descendant tree.
func killOwnSubtree() {
	for _, pid := range descendantsOf(os.Getpid()) {
		syscall.Kill(pid, syscall.SIGKILL)
	}
}

// reapStrayWorkspaceProcesses kills worker processes a crashed prior server left
// re-parented to launchd — scoped to worker-looking commands under the
// workspace, never the GUI app or our own tree.
func reapStrayWorkspaceProcesses(workspacePath string) {
	out, err := exec.Command("pgrep", "-f", workspacePath).Output()
	if err != nil {
		return
	}
	ours := map[int]bool{os.Getpid(): true, os.Getppid(): true}
	for _, pid := range descendantsOf(os.Getpid()) {
		ours[pid] = true
	}
	worker := regexp.MustCompile(`\bnode\b|\.sh(\s|$)|\b(claude|codex|hermes|pi)\b`)
	for _, line := range strings.Split(string(out), "\n") {
		pid, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil || pid == 0 || ours[pid] {
			continue
		}
		cmdOut, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
		if err != nil {
			continue
		}
		cmd := strings.TrimSpace(string(cmdOut))
		if strings.Contains(cmd, "LiquidOS.app/Contents/MacOS") || !worker.MatchString(cmd) {
			continue
		}
		syscall.Kill(pid, syscall.SIGKILL)
	}
}

// killService SIGTERMs then (after a grace period) SIGKILLs a service's process
// tree. Returns false if no such service.
func (r *serviceRegistry) killService(id string) bool {
	r.mu.Lock()
	svc, ok := r.services[id]
	if !ok {
		r.mu.Unlock()
		return false
	}
	delete(r.services, id)
	r.mu.Unlock()

	if svc.source != "" && r.dropSource != nil {
		r.dropSource(svc.source)
	}
	root := svc.cmd.Process.Pid
	tree := append([]int{root}, descendantsOf(root)...)
	for _, pid := range tree {
		syscall.Kill(pid, syscall.SIGTERM)
	}
	afterDelay(1500, func() {
		for _, pid := range append([]int{root}, descendantsOf(root)...) {
			syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	return true
}

// spawnService launches script (idempotent per script path: any prior service
// for the same abs is killed first). The script is run as an executable with
// [dispatchId, ...args]; stdout/stderr are prefixed and logged.
func (r *serviceRegistry) spawnService(abs, label, dispatchID string, args []string, env map[string]string) (id string, pid int) {
	// Idempotent per script path.
	r.mu.Lock()
	var toKill []string
	for existingID, svc := range r.services {
		if svc.abs == abs {
			toKill = append(toKill, existingID)
		}
	}
	r.mu.Unlock()
	for _, existingID := range toKill {
		r.killService(existingID)
	}

	if dispatchID == "" {
		dispatchID = newDispatchID(label)
	}
	cmd := exec.Command(abs, append([]string{dispatchID}, args...)...)
	cmd.Dir = filepath.Dir(abs)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // detached process group
	cmd.Env = append(os.Environ(), "LIQUIDOS_DISPATCH_ID="+dispatchID)
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	// A service the server can't launch is a crash to recover from — server.js
	// does not catch the spawn error, letting recovery handle it. We surface it
	// the same way by logging; the caller treats a zero pid as failure.
	if err := cmd.Start(); err != nil {
		r.logf("service spawn failed: " + err.Error())
		return "", 0
	}

	id = newServiceID()
	if label == "" {
		label = filepath.Base(abs)
	}
	r.mu.Lock()
	r.services[id] = &service{cmd: cmd, label: label, dispatchID: dispatchID, abs: abs}
	r.mu.Unlock()

	go pipePrefixed(stdout, "["+id+"] ", r.logf)
	go pipePrefixed(stderr, "["+id+"] ", r.logf)
	go func() {
		cmd.Wait()
		r.mu.Lock()
		delete(r.services, id)
		r.mu.Unlock()
	}()

	return id, cmd.Process.Pid
}

func pipePrefixed(r interface{ Read([]byte) (int, error) }, prefix string, logf func(string)) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		logf(prefix + scanner.Text())
	}
}

func (r *serviceRegistry) shutdown() {
	r.mu.Lock()
	ids := make([]string, 0, len(r.services))
	for id := range r.services {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.killService(id)
	}
}
