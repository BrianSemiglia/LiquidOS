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

const callbackPromptText = job => job.prompt || job.request || '';

const relativeScope = (canvasesRoot, scope) => {
    if (!scope) {
        return '(unknown)';
    }

    if (!path.isAbsolute(scope)) {
        return String(scope).split(path.sep).join('/');
    }

    return path.relative(canvasesRoot, scope).split(path.sep).join('/') || '.';
};

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
            'prompt:',
            callbackPromptText(job) || '(no prompt)',
            '',
            'Scope: ' + relativeScope(canvasesRoot, job.scope || currentCanvasPath())
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
        commitCanvases
    };
};

module.exports = {
    createGitTimeline
};
