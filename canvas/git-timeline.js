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

const callbackPromptText = job => job && job.prompt ? job.prompt : '';

const scopeText = (scope, currentCanvasPath) => {
    const value = String(scope || '').trim();

    if (!value || value === '.' || value === './') {
        return currentCanvasPath();
    }

    return path.isAbsolute(value) ? path.normalize(value) : path.resolve(currentCanvasPath(), value.replace(/^\.\//, ''));
};

const isCrashReason = reason => /uncaught exception|unhandled rejection|crash/i.test(String(reason || ''));

const quoteEventValue = value => String(value || '').replace(/[\n\r]+/g, ' ').replace(/'/g, "\\'");

const commitMessage = ({ event, scope, agentResponse }) => [
    'Event:',
    event || 'User did prompt',
    '',
    'Scope:',
    scope || '(unknown)',
    '',
    'Agent Response:',
    agentResponse || 'none'
].join('\n');

const eventWithParameter = (event, parameter, value) => value
    ? `${event} with ${parameter} '${quoteEventValue(value)}'`
    : event;

const promptEvent = job => {
    if (job && job.event) {
        return job.event;
    }

    return eventWithParameter('User did prompt', 'prompt', callbackPromptText(job));
};

const crashEvent = error => eventWithParameter('LiquidOS did crash', 'error', error);

const shutdownEvent = reason => isCrashReason(reason)
    ? crashEvent(reason)
    : 'User did quit';

const workspaceName = workspacePath => path.basename(String(workspacePath || '').replace(/\/+$/, ''), '.liquidos');

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

            if (git(canvasesRoot, ['commit', '-m', commitMessage({
                event: eventWithParameter('User did create workspace', 'name', workspaceName(canvasesRoot)),
                scope: canvasesRoot,
                agentResponse: 'none'
            })], { stdio: 'inherit' }).status !== 0) {
                throw new Error('Failed to commit initial canvases snapshot');
            }
        }

        return canvasesRoot;
    };

    const commitFailedCanvases = (job, agentResponse = '', error = '') => {
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
            event: crashEvent(error || agentResponse),
            scope: scopeText(job.scope, currentCanvasPath),
            agentResponse: agentResponse || 'none'
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


    const commitShutdownCanvases = (job, reason = '') => {
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
            event: shutdownEvent(reason),
            scope: scopeText(job && job.scope ? job.scope : '', currentCanvasPath),
            agentResponse: job && job.agentResponse ? job.agentResponse : 'none'
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

    const commitCanvases = (job, context = '') => {
        ensureCanvasesGitRepo();

        if (git(canvasesRoot, ['add', '-A'], { stdio: 'inherit' }).status !== 0) {
            logServer('git', 'failed to stage canvases changes', { jobId: job.id || null });
            return false;
        }

        if (git(canvasesRoot, ['diff', '--cached', '--quiet']).status === 0) {
            logServer('git', 'no canvases changes to commit', { jobId: job.id || null });
            return false;
        }

        if (git(canvasesRoot, ['commit', '-m', commitMessage({
            event: promptEvent(job),
            scope: scopeText(job.scope, currentCanvasPath),
            agentResponse: context || 'none'
        })], { stdio: 'inherit' }).status !== 0) {
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
