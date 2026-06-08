const path = require('path');

const createOutputQueue = ({
    workspacePath,
    getCanvasPath,
    logServer,
    logHermesError,
    callbackPromptText,
    shortText,
    resolveCanvasReference,
    isCanvasScope
}) => {
    const resolveFromWorkspacePath = value =>
        path.isAbsolute(value) ? value : path.resolve(workspacePath, value);

    // The job queue is in-memory state owned by this canvas runtime.
    // It is not persisted: a process crash drops pending work, and a
    // canvas switch resets it (jobs are scoped to the canvas that
    // enqueued them; running them against a different canvas would
    // dispatch the agent into the wrong scope).
    let jobs = [];
    let outputDispatchTimer = null;
    let outputDispatching = false;
    let activeOutputKeys = new Set();
    let processJob = null;

    const outputJobKey = job => {
        if (!job) {
            return null;
        }

        if (isCanvasScope(job.scope)) {
            return 'canvas';
        }

        if (typeof job.componentKey === 'string' && job.componentKey.trim()) {
            return job.componentKey.trim();
        }

        if (typeof job.componentPath === 'string' && job.componentPath.trim()) {
            return resolveCanvasReference(job.componentPath);
        }

        if (job.target && typeof job.target === 'object' && typeof job.target.componentPath === 'string' && job.target.componentPath.trim()) {
            return resolveCanvasReference(job.target.componentPath);
        }

        if (typeof job.file === 'string' && job.file.trim()) {
            return resolveFromWorkspacePath(job.file);
        }

        return 'canvas';
    };

    const outputJobSummary = job => ({
        id: job && job.id ? job.id : null,
        status: job && job.status ? job.status : null,
        lane: job ? outputJobKey(job) : null,
        scope: job && job.scope ? job.scope : null,
        componentPath: job && job.componentPath ? job.componentPath : null,
        file: job && job.file ? job.file : null,
        prompt: job ? shortText(callbackPromptText(job)) : ''
    });

    const appendOutputJob = async job => {
        jobs.push(job);
        logServer('queue', 'job enqueued', {
            canvas: getCanvasPath(),
            depth: jobs.filter(item => item && ['pending', 'running'].includes(item.status)).length,
            job: outputJobSummary(job)
        });
        return job;
    };


    const updateOutputJob = async (jobId, patch) => {
        let updated = false;
        jobs = jobs.map(job => {
            if (job.id !== jobId) {
                return job;
            }

            updated = true;
            return { ...job, ...patch };
        });
        return updated;
    };

    // Called when the canvas runtime starts (initial load or canvas switch).
    const activeOutputJobs = () =>
        jobs.filter(job => ['pending', 'running'].includes(job.status) && callbackPromptText(job));

    const dispatchableJobs = candidate => {
        if (activeOutputKeys.size) {
            return [];
        }

        return candidate
            .filter(job => job.status === 'pending' && callbackPromptText(job))
            .slice(0, 1);
    };

    const scheduleOutputDispatch = () => {
        if (outputDispatchTimer) {
            return;
        }

        outputDispatchTimer = setTimeout(() => {
            outputDispatchTimer = null;
            dispatchOutputJobs().catch(error => {
                logHermesError('output-dispatch', error, { message: 'output dispatch error' });
            });
        }, 25);
    };

    const dispatchOutputJobs = async () => {
        if (outputDispatching) {
            return false;
        }

        outputDispatching = true;

        try {
            const ready = dispatchableJobs(jobs);

            if (!ready.length) {
                logServer('queue', 'dispatch idle', {
                    canvas: getCanvasPath(),
                    pending: jobs.filter(job => job && job.status === 'pending' && callbackPromptText(job)).length,
                    running: jobs.filter(job => job && job.status === 'running' && callbackPromptText(job)).length,
                    activeLanes: Array.from(activeOutputKeys)
                });
                return false;
            }

            const job = ready[0];
            const laneKey = outputJobKey(job);

            logServer('queue', 'dispatching job', {
                canvas: getCanvasPath(),
                job: outputJobSummary(job)
            });

            activeOutputKeys.add(laneKey);
            logServer('queue', 'lane reserved', {
                lane: laneKey,
                job: outputJobSummary(job),
                activeLanes: Array.from(activeOutputKeys)
            });

            if (typeof processJob !== 'function') {
                logHermesError('agent-job', new Error('No queue processor has been set'), { message: 'agent job error' });
                activeOutputKeys.delete(laneKey);
                scheduleOutputDispatch();
                return false;
            }

            setImmediate(() => {
                Promise.resolve()
                    .then(() => processJob(job))
                    .catch(error => {
                        logHermesError('agent-job', error, { message: 'agent job error' });
                    })
                    .finally(() => {
                        activeOutputKeys.delete(laneKey);
                        logServer('queue', 'lane released', {
                            lane: laneKey,
                            jobId: job.id || null,
                            activeLanes: Array.from(activeOutputKeys)
                        });
                        scheduleOutputDispatch();
                    });
            });

            return true;
        } finally {
            outputDispatching = false;
        }
    };

    const feedHermesOutput = () => {
        logServer('queue', 'dispatch requested', {
            canvas: getCanvasPath(),
            activeLanes: Array.from(activeOutputKeys)
        });
        scheduleOutputDispatch();
        return true;
    };

    const currentBusyState = key => {
        const activeJobs = activeOutputJobs();
        const componentKey = key ? String(key).trim() : '';
        const filtered = componentKey
            ? activeJobs.filter(job => isCanvasScope(job.scope) || outputJobKey(job) === componentKey)
            : activeJobs;
        const job = filtered[filtered.length - 1] || activeJobs[activeJobs.length - 1] || null;

        return {
            busy: Boolean(filtered.length),
            job: job ? outputJobSummary(job) : null,
            jobs: filtered.map(outputJobSummary)
        };
    };

    const clearActiveLanes = () => {
        activeOutputKeys.clear();
    };

    const setProcessJob = fn => {
        processJob = fn;
        return processJob;
    };

    return {
        outputJobKey,
        outputJobSummary,
        appendOutputJob,
        updateOutputJob,
        currentBusyState,
        feedHermesOutput,
        clearActiveLanes,
        setProcessJob
    };
};

module.exports = {
    createOutputQueue
};
