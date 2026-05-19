const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const gitArgs = args => [
    '-c', 'user.name=LiquidOS',
    '-c', 'user.email=liquidos@local',
    ...args
];

const git = (cwd, args, options = {}) =>
    spawnSync('git', gitArgs(args), {
        cwd,
        encoding: options.encoding || 'utf8',
        stdio: options.stdio || 'pipe'
    });

const callbackPromptText = job => job && (job.prompt || job.request) ? job.prompt || job.request : '';

const scopeText = (scope, currentCanvasPath) => {
    const value = String(scope || '').trim();

    if (!value || value === '.' || value === './') {
        return currentCanvasPath();
    }

    return path.isAbsolute(value) ? path.normalize(value) : path.resolve(currentCanvasPath(), value.replace(/^\.\//, ''));
};

const commitMessage = ({ prompt, scope, shutdownReason }) => [
    'Prompt:',
    prompt || '(no active prompt)',
    '',
    'Scope:',
    scope || '(unknown)',
    '',
    'Shutdown-Reason:',
    shutdownReason || '(unknown)'
].join('\n');

const createGitTimeline = ({ canvasesRoot, currentCanvasPath, logServer }) => {
    const ensureCanvasesGitRepo = () => {
        fs.mkdirSync(canvasesRoot, { recursive: true });

        if (path.resolve((git(canvasesRoot, ['rev-parse', '--show-toplevel']).stdout || '').trim()) !== path.resolve(canvasesRoot)) {
            if (git(canvasesRoot, ['init'], { stdio: 'inherit' }).status !== 0) {
                throw new Error('Failed to initialize git repo for canvases');
            }
        }

        if (git(canvasesRoot, ['rev-parse', '--verify', 'HEAD']).status !== 0) {
            if (git(canvasesRoot, ['add', '-A'], { stdio: 'inherit' }).status !== 0) {
                throw new Error('Failed to stage initial canvases snapshot');
            }

            if (git(canvasesRoot, ['commit', '-m', 'canvases: initial snapshot\n\nApp-Action: baseline'], { stdio: 'inherit' }).status !== 0) {
                throw new Error('Failed to commit initial canvases snapshot');
            }
        }

        return canvasesRoot;
    };

    const commitFailedCanvases = (job, error) => {
        ensureCanvasesGitRepo();

        if (git(canvasesRoot, ['add', '-A'], { stdio: 'inherit' }).status !== 0) {
            logServer('git', 'failed to stage failed job canvases changes', { jobId: job.id || null });
            return false;
        }

        if (git(canvasesRoot, ['diff', '--cached', '--quiet']).status === 0) {
            logServer('git', 'no failed job canvases changes to commit', { jobId: job.id || null });
            return false;
        }

        if (git(canvasesRoot, ['commit', '-m', commitMessage({
            prompt: callbackPromptText(job),
            scope: scopeText(job.scope, currentCanvasPath),
            shutdownReason: 'Hermes failed: ' + (error && error.message ? error.message : String(error || 'unknown'))
        })], { stdio: 'inherit' }).status !== 0) {
            logServer('git', 'failed to commit failed job canvases changes', {
                jobId: job.id || null,
                prompt: callbackPromptText(job) || null
            });
            return false;
        }

        logServer('git', 'committed failed job canvases changes', { jobId: job.id || null });
        return true;
    };


    const commitShutdownCanvases = (job, reason = 'application was shut down') => {
        ensureCanvasesGitRepo();

        if (git(canvasesRoot, ['add', '-A'], { stdio: 'inherit' }).status !== 0) {
            logServer('git', 'failed to stage shutdown canvases changes', { jobId: job && job.id ? job.id : null });
            return false;
        }

        if (git(canvasesRoot, ['diff', '--cached', '--quiet']).status === 0) {
            logServer('git', 'no shutdown canvases changes to commit', { jobId: job && job.id ? job.id : null });
            return false;
        }

        if (git(canvasesRoot, ['commit', '-m', commitMessage({
            prompt: callbackPromptText(job || {}),
            scope: scopeText(job && job.scope ? job.scope : '', currentCanvasPath),
            shutdownReason: String(reason || 'application was shut down')
        })], { stdio: 'inherit' }).status !== 0) {
            logServer('git', 'failed to commit shutdown canvases changes', {
                jobId: job && job.id ? job.id : null,
                prompt: callbackPromptText(job || {}) || null
            });
            return false;
        }

        logServer('git', 'committed shutdown canvases changes', { jobId: job && job.id ? job.id : null });
        return true;
    };

    const commitCanvases = job => {
        ensureCanvasesGitRepo();

        if (git(canvasesRoot, ['add', '-A'], { stdio: 'inherit' }).status !== 0) {
            logServer('git', 'failed to stage canvases changes', { jobId: job.id || null });
            return false;
        }

        if (git(canvasesRoot, ['diff', '--cached', '--quiet']).status === 0) {
            logServer('git', 'no canvases changes to commit', { jobId: job.id || null });
            return false;
        }

        if (git(canvasesRoot, ['commit', '-m', [
            'Prompt:',
            callbackPromptText(job) || '(no prompt)',
            '',
            'Scope:',
            scopeText(job.scope, currentCanvasPath)
        ].join('\n')], { stdio: 'inherit' }).status !== 0) {
            logServer('git', 'failed to commit canvases changes', {
                jobId: job.id || null,
                prompt: callbackPromptText(job) || null
            });
            return false;
        }

        logServer('git', 'committed canvases changes', { jobId: job.id || null });
        return true;
    };

    return {
        ensureCanvasesGitRepo,
        commitCanvases,
        commitFailedCanvases,
        commitShutdownCanvases
    };
};

module.exports = {
    createGitTimeline
};
