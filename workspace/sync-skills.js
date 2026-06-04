// Workspace skill synchronization.
//
// On every server startup the runtime:
//   1. Ensures the workspace is a git repo (init + sensible .gitignore +
//      a seed commit). One-time per workspace. Idempotent — no-ops if
//      git-timeline's ensureCanvasesGitRepo already ran or will run.
//   2. Overwrites <workspace>/skills/ with the runtime's bundled skills.
//   3. Stages skills/ and asks git whether the staged tree differs from HEAD.
//   4. If yes, commits ("Runtime did update skills") for audit history.
//
// This module does NOT decide whether the workspace needs a fix-up. That
// decision is made by the runtime trying to load the workspace and seeing
// what fails (see server.js's collectWorkspaceErrors). Skill prose changes
// shouldn't trigger an agent run when the workspace happens to still work.
//
// Commits use the same -c user.name/user.email and structured Event/Scope/
// Agent Response format as canvas/git-timeline.js so the workspace history
// stays uniform regardless of which subsystem committed.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_AUTHOR = [
    '-c', 'user.name=LiquidOS',
    '-c', 'user.email=liquidos@local'
];

const git = (cwd, args, opts = {}) =>
    spawnSync('git', [...GIT_AUTHOR, ...args], {
        cwd,
        encoding: 'utf8',
        stdio: opts.stdio || ['ignore', 'pipe', 'pipe']
    });

const gitOut = (cwd, args) => {
    const r = git(cwd, args);
    if (r.status !== 0) return null;
    return (r.stdout || '').trim();
};

const commitMessage = ({ event, scope, agentResponse }) => [
    'Event:', event || '(unknown)',
    '',
    'Scope:', scope || '(workspace)',
    '',
    'Agent Response:', agentResponse || 'none'
].join('\n');

const workspaceName = workspacePath =>
    path.basename(String(workspacePath || '').replace(/\/+$/, ''), '.liquidos');

// The set of entries the workspace's .gitignore must always contain.
// Re-applied on every launch so existing workspaces created before a
// rule was added pick it up without a manual edit.
const REQUIRED_GITIGNORE_ENTRIES = [
    '**/diagnostics/',
    '**/data/.runtime/',
    '**/.presented/',
    '.DS_Store',
    '/.claude/',
    '/.codex/',
    '/.hermes/',
    '/.pi/',
    '/.agents/',
    '/AGENTS.md'
];

const ensureWorkspaceGitignore = workspacePath => {
    const gitignorePath = path.join(workspacePath, '.gitignore');
    const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    const present = new Set(current.split('\n').map(line => line.trim()));
    const missing = REQUIRED_GITIGNORE_ENTRIES.filter(entry => !present.has(entry));

    if (!missing.length && current) {
        return;
    }

    const header = current
        ? current.endsWith('\n') ? current : current + '\n'
        : '# Runtime-managed; regenerated each session and noisy to track.\n';
    fs.writeFileSync(gitignorePath, header + missing.join('\n') + (missing.length ? '\n' : ''));
};

const ensureGitRepo = workspacePath => {
    const inGit = gitOut(workspacePath, ['rev-parse', '--show-toplevel']);
    if (inGit && path.resolve(inGit) === path.resolve(workspacePath)) return false;

    if (git(workspacePath, ['init', '-q']).status !== 0) {
        throw new Error('git init failed in ' + workspacePath);
    }

    ensureWorkspaceGitignore(workspacePath);

    // Seed an initial commit. Mirrors git-timeline's first-commit message so
    // the two paths produce comparable history if either runs first.
    if (gitOut(workspacePath, ['rev-parse', '--verify', 'HEAD']) === null) {
        if (git(workspacePath, ['add', '-A']).status !== 0) {
            throw new Error('git add failed during workspace init');
        }
        if (git(workspacePath, ['commit', '--allow-empty', '-q', '-m', commitMessage({
            event: `User did create workspace with name '${workspaceName(workspacePath)}'`,
            scope: workspacePath,
            agentResponse: 'none'
        })]).status !== 0) {
            throw new Error('git commit failed during workspace init');
        }
    }
    return true;
};

const replaceDir = (sourcePath, destPath) => {
    if (fs.existsSync(destPath)) fs.rmSync(destPath, { recursive: true });
    fs.cpSync(sourcePath, destPath, { recursive: true });
};

const hasStagedDelta = (workspacePath, paths) =>
    git(workspacePath, ['diff', '--cached', '--quiet', '--', ...paths]).status === 1;

const syncSkills = ({ workspacePath, skillsSourcePath }) => {
    const result = {
        initialized: false,
        updated: false,
        sha: null,
        parentSha: null,
        error: null
    };

    try {
        result.initialized = ensureGitRepo(workspacePath);
        ensureWorkspaceGitignore(workspacePath);

        replaceDir(skillsSourcePath, path.join(workspacePath, 'skills'));

        if (git(workspacePath, ['add', '--', 'skills', '.gitignore']).status !== 0) {
            throw new Error('git add skills failed');
        }

        if (hasStagedDelta(workspacePath, ['skills', '.gitignore'])) {
            if (git(workspacePath, ['commit', '-q', '-m', commitMessage({
                event: 'Runtime did update skills',
                scope: 'skills',
                agentResponse: 'none'
            })]).status !== 0) {
                throw new Error('git commit (skills update) failed');
            }
            result.updated = true;
            result.sha = gitOut(workspacePath, ['rev-parse', 'HEAD']);
            result.parentSha = gitOut(workspacePath, ['rev-parse', 'HEAD~1']);
        }
    } catch (error) {
        result.error = error.message;
    }

    return result;
};

module.exports = { syncSkills };
