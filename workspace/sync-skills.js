// Workspace skill synchronization.
//
// On every server startup the runtime:
//   1. Ensures the workspace is a git repo (init + sensible .gitignore +
//      a seed commit). One-time per workspace. Idempotent — no-ops if
//      git-timeline's ensureCanvasesGitRepo already ran or will run.
//   2. Overwrites <workspace>/skills/ with the runtime's bundled skills.
//   3. Stages skills/ and asks git whether the staged tree differs from HEAD.
//   4. If yes, commits ("Runtime did update skills") and drops a marker at
//      .liquidos/migration-pending containing the new commit SHA.
//
// The marker is what downstream code (an agent migration step) uses to
// decide whether to act. The git commit is the audit trail and the diff
// source. The runtime never invokes the agent itself — it just produces
// the trigger.
//
// Commits use the same -c user.name/user.email and structured Event/Scope/
// Agent Response format as canvas/git-timeline.js so the workspace history
// stays uniform regardless of which subsystem committed.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PENDING_MARKER_REL = path.join('.liquidos', 'migration-pending');

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

const ensureGitRepo = workspacePath => {
    const inGit = gitOut(workspacePath, ['rev-parse', '--show-toplevel']);
    if (inGit && path.resolve(inGit) === path.resolve(workspacePath)) return false;

    if (git(workspacePath, ['init', '-q']).status !== 0) {
        throw new Error('git init failed in ' + workspacePath);
    }

    const gitignorePath = path.join(workspacePath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, [
            '# Runtime-managed; regenerated each session and noisy to track.',
            '**/diagnostics/',
            '**/data/.runtime/',
            '**/.presented/',
            '.DS_Store',
            ''
        ].join('\n'));
    }

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

const hasStagedSkillsDelta = workspacePath =>
    git(workspacePath, ['diff', '--cached', '--quiet', '--', 'skills']).status === 1;

const writeMarker = (workspacePath, sha) => {
    const markerPath = path.join(workspacePath, PENDING_MARKER_REL);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, sha + '\n');
};

const syncSkills = ({ workspacePath, skillsSourcePath }) => {
    const result = {
        initialized: false,
        updated: false,
        sha: null,
        parentSha: null,
        migrationPending: false,
        error: null
    };

    try {
        result.initialized = ensureGitRepo(workspacePath);

        replaceDir(skillsSourcePath, path.join(workspacePath, 'skills'));

        if (git(workspacePath, ['add', '--', 'skills']).status !== 0) {
            throw new Error('git add skills failed');
        }

        if (hasStagedSkillsDelta(workspacePath)) {
            // Look at the parent BEFORE committing — if it didn't have a
            // skills/ tree, then this is the workspace's first encounter with
            // skills and there's no prior state to migrate from. We still
            // commit (so the workspace records what it was synced to), but we
            // skip writing the migration marker. General rule, no "first
            // time" special case.
            const parentHadSkills = gitOut(workspacePath, ['cat-file', '-t', 'HEAD:skills']) === 'tree';

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
            if (result.sha && parentHadSkills) writeMarker(workspacePath, result.sha);
        }

        result.migrationPending = fs.existsSync(path.join(workspacePath, PENDING_MARKER_REL));
    } catch (error) {
        result.error = error.message;
    }

    return result;
};

module.exports = { syncSkills, PENDING_MARKER_REL };
