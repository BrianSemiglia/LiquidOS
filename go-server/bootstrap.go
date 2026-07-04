package main

// bootstrap.go — Go port of workspace/bootstrap.js.
//
// On every startup, ensure the workspace is a git repo with the runtime-managed
// .gitignore (regenerated to exactly this list each launch — the single source
// of truth) and a node_modules symlink to the app's, so an agent-written probe
// anywhere in the workspace can import app deps with zero config. Commits use
// the same identity + Event/Scope/Agent Response format as the timeline.

import (
	"os"
	"path/filepath"
	"strings"
)

const gitignoreHeader = "# Runtime-managed; regenerated each session and noisy to track."

var requiredGitignoreEntries = []string{
	"**/data/.runtime/",
	"**/data/*.app/",
	".DS_Store",
	"/.claude/",
	"/.codex/",
	"/.hermes/",
	"/.liquidos/server.log",
	"/.pi/",
	"/.agents/",
	"/AGENTS.md",
	"/node_modules",
	"/skills",
}

func ensureWorkspaceGitignore(workspacePath string) {
	gitignorePath := filepath.Join(workspacePath, ".gitignore")
	desired := gitignoreHeader + "\n" + strings.Join(requiredGitignoreEntries, "\n") + "\n"
	if current, err := os.ReadFile(gitignorePath); err == nil && string(current) == desired {
		return
	}
	os.WriteFile(gitignorePath, []byte(desired), 0o644)
}

// ensureGitRepo initializes the workspace repo + seed commit if needed; returns
// true when it created the repo this call.
func ensureGitRepo(workspacePath string) (bool, error) {
	inGit, status := gitRun(workspacePath, "rev-parse", "--show-toplevel")
	if status == 0 {
		// git reports the symlink-resolved path; resolve ours too so an
		// existing repo under a symlinked root (e.g. macOS /var -> /private/var)
		// isn't misread as "not mine" and needlessly re-initialized.
		if samePath(strings.TrimSpace(inGit), workspacePath) {
			return false, nil
		}
	}

	if _, s := gitRun(workspacePath, "init", "-q"); s != 0 {
		return false, &statusError{code: 500, msg: "git init failed in " + workspacePath}
	}
	ensureWorkspaceGitignore(workspacePath)

	if _, s := gitRun(workspacePath, "rev-parse", "--verify", "HEAD"); s != 0 {
		if _, s := gitRun(workspacePath, "add", "-A"); s != 0 {
			return false, &statusError{code: 500, msg: "git add failed during workspace init"}
		}
		msg := commitMessage(
			eventWithParameter("User did create workspace", "name", workspaceName(workspacePath)),
			workspacePath, "none")
		if _, s := gitRun(workspacePath, "commit", "--allow-empty", "-q", "-m", msg); s != 0 {
			return false, &statusError{code: 500, msg: "git commit failed during workspace init"}
		}
	}
	return true, nil
}

// samePath reports whether two paths refer to the same location, resolving
// symlinks (falling back to lexical Abs when a path doesn't exist yet).
func samePath(a, b string) bool {
	ra, ea := filepath.EvalSymlinks(a)
	rb, eb := filepath.EvalSymlinks(b)
	if ea == nil && eb == nil {
		return ra == rb
	}
	aa, _ := filepath.Abs(a)
	ab, _ := filepath.Abs(b)
	return aa == ab
}

func hasStagedDelta(workspacePath string, paths ...string) bool {
	args := append([]string{"diff", "--cached", "--quiet", "--"}, paths...)
	_, status := gitRun(workspacePath, args...)
	return status == 1
}

// ensureNodeModulesLink symlinks <workspace>/node_modules to the app's, so an
// agent probe can import playwright etc. with no NODE_PATH. Best-effort; never
// clobbers a real node_modules.
func ensureNodeModulesLink(workspacePath, appRoot string) {
	appModules := filepath.Join(appRoot, "node_modules")
	if _, err := os.Stat(appModules); err != nil {
		return
	}
	link := filepath.Join(workspacePath, "node_modules")
	if info, err := os.Lstat(link); err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return // a real node_modules — leave it
		}
		linkReal, _ := filepath.EvalSymlinks(link)
		appReal, _ := filepath.EvalSymlinks(appModules)
		if linkReal == appReal {
			return // already linked
		}
		os.Remove(link) // stale link — replace
	}
	os.Symlink(appModules, link)
}

// bootstrapResult mirrors the {initialized, error} the JS returns.
type bootstrapResult struct {
	initialized bool
	err         string
}

// bootstrapWorkspace ensures repo + .gitignore + node_modules link and commits a
// .gitignore change. Failures are captured, not thrown — the runtime should
// still come up so the user can recover (server.js startup).
func bootstrapWorkspace(workspacePath, appRoot string) bootstrapResult {
	res := bootstrapResult{}
	initialized, err := ensureGitRepo(workspacePath)
	if err != nil {
		res.err = err.Error()
		return res
	}
	res.initialized = initialized

	ensureWorkspaceGitignore(workspacePath)
	ensureNodeModulesLink(workspacePath, appRoot)

	if _, s := gitRun(workspacePath, "add", "--", ".gitignore"); s != 0 {
		res.err = "git add .gitignore failed"
		return res
	}
	if hasStagedDelta(workspacePath, ".gitignore") {
		msg := commitMessage("Runtime did update workspace gitignore", ".gitignore", "none")
		if _, s := gitRun(workspacePath, "commit", "-q", "-m", msg); s != 0 {
			res.err = "git commit (.gitignore) failed"
		}
	}
	return res
}
