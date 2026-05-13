const path = require('path');

const createOutputQueue = ({
    root,
    fs,
    getCanvasPath,
    getOutputPath,
    logServer,
    logHermesError,
    readJson,
    writeJson,
    callbackPromptText,
    shortText,
    resolveCanvasReference,
    isCanvasScope
}) => {
    const isObject = value => value !== null && typeof value === 'object';
    const resolveFromRoot = value =>
        path.isAbsolute(value) ? value : path.resolve(root, value);

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    let outputDispatchTimer = null;
    let outputDispatching = false;
    let activeOutputKeys = new Set();
    let processJob = null;

    const withOutputLock = async task => {
        const lockPath = getOutputPath() + '.lock';
        const start = Date.now();

        while (fs.existsSync(lockPath)) {
            if (Date.now() - start > 5_000) {
                throw new Error('Timed out waiting for output queue lock');
            }

            await sleep(5);
        }

        fs.writeFileSync(lockPath, String(process.pid));

        try {
            return await task();
        } finally {
            try {
                fs.unlinkSync(lockPath);
            } catch (_) {
                // Best effort.
            }
        }
    };

    const outputText = () =>
        fs.existsSync(getOutputPath()) ? fs.readFileSync(getOutputPath(), 'utf8') : '';

    const readOutputJobs = () => {
        const text = outputText().trim();

        if (!text) {
            return [];
        }

        let value;

        try {
            value = JSON.parse(text);
        } catch (error) {
            logHermesError('output', error, {
                message: 'output.json parse failed; recovering with an empty job queue'
            });

            try {
                writeJson(getOutputPath(), []);
            } catch (_) {
                // Ignore recovery write failures; the in-memory fallback still keeps the server alive.
            }

            return [];
        }

        if (Array.isArray(value)) {
            return value.filter(isObject);
        }

        return isObject(value) && Object.keys(value).length ? [value] : [];
    };

    const readOutputJob = () => {
        const jobs = readOutputJobs();
        return [...jobs].reverse().find(job => job.status === 'pending' || job.status === 'running') || jobs[jobs.length - 1] || null;
    };

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
            return resolveFromRoot(job.file);
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

    const writeOutputJobs = async jobs =>
        withOutputLock(async () => {
            writeJson(getOutputPath(), Array.isArray(jobs) ? jobs : []);
        });

    const appendOutputJob = async job =>
        withOutputLock(async () => {
            const jobs = readOutputJobs();
            const jobKey = outputJobKey(job);
            const jobPrompt = callbackPromptText(job);
            const existing = jobs.find(item =>
                item
                && ['pending', 'running'].includes(item.status)
                && outputJobKey(item) === jobKey
                && callbackPromptText(item) === jobPrompt
            );

            if (existing) {
                logServer('queue', 'duplicate job ignored', {
                    canvas: getCanvasPath(),
                    existing: outputJobSummary(existing),
                    duplicate: outputJobSummary(job)
                });
                return existing;
            }

            jobs.push(job);
            writeJson(getOutputPath(), jobs);
            logServer('queue', 'job enqueued', {
                canvas: getCanvasPath(),
                depth: jobs.filter(item => item && ['pending', 'running'].includes(item.status)).length,
                job: outputJobSummary(job)
            });
            return job;
        });

    const updateOutputJob = async (jobId, patch) =>
        withOutputLock(async () => {
            const jobs = readOutputJobs();
            let updated = false;
            const nextJobs = jobs.map(job => {
                if (job.id !== jobId) {
                    return job;
                }

                updated = true;
                return { ...job, ...patch };
            });

            if (updated) {
                writeJson(getOutputPath(), nextJobs);
            }

            return updated;
        });

    const normalizeOutputJobs = () => {
        const jobs = readOutputJobs();
        const normalized = jobs.map(job => (
            job && job.status === 'running'
                ? {
                    ...job,
                    status: 'pending',
                    resumedAt: new Date().toISOString(),
                    startedAt: null
                }
                : job
        ));

        if (normalized.length !== jobs.length || JSON.stringify(normalized) !== JSON.stringify(jobs)) {
            writeJson(getOutputPath(), normalized);
            logServer('queue', 'normalized running jobs', {
                canvas: getCanvasPath(),
                recovered: jobs.filter(job => job && job.status === 'running').length
            });
        } else if (!fs.existsSync(getOutputPath())) {
            writeJson(getOutputPath(), []);
        }
    };

    const activeOutputJobs = () =>
        readOutputJobs().filter(job => ['pending', 'running'].includes(job.status) && callbackPromptText(job));

    const dispatchableJobs = jobs => {
        if (activeOutputKeys.size) {
            return [];
        }

        return jobs
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
            while (true) {
                const jobs = readOutputJobs();
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

                logServer('queue', 'dispatching jobs', {
                    canvas: getCanvasPath(),
                    jobs: ready.map(outputJobSummary)
                });

                ready.forEach(job => {
                    const laneKey = outputJobKey(job);
                    activeOutputKeys.add(laneKey);
                    logServer('queue', 'lane reserved', {
                        lane: laneKey,
                        job: outputJobSummary(job),
                        activeLanes: Array.from(activeOutputKeys)
                    });

                    if (typeof processJob !== 'function') {
                        logHermesError('agent-job', new Error('No queue processor has been set'), { message: 'agent job error' });
                        activeOutputKeys.delete(laneKey);
                        return;
                    }

                    let jobPromise;

                    try {
                        jobPromise = processJob(job);
                    } catch (error) {
                        logHermesError('agent-job', error, { message: 'agent job error' });
                        activeOutputKeys.delete(laneKey);
                        logServer('queue', 'lane released', {
                            lane: laneKey,
                            jobId: job.id || null,
                            activeLanes: Array.from(activeOutputKeys)
                        });
                        scheduleOutputDispatch();
                        return;
                    }

                    Promise.resolve(jobPromise)
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

                if (ready.some(job => outputJobKey(job) === 'canvas')) {
                    return true;
                }

                if (!readOutputJobs().some(job => job.status === 'pending' && callbackPromptText(job) && !activeOutputKeys.has(outputJobKey(job)))) {
                    return true;
                }
            }
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
        const jobs = componentKey
            ? activeJobs.filter(job => isCanvasScope(job.scope) || outputJobKey(job) === componentKey)
            : activeJobs;
        const job = jobs[jobs.length - 1] || activeJobs[activeJobs.length - 1] || null;

        return {
            busy: Boolean(jobs.length),
            job: job ? outputJobSummary(job) : null,
            jobs: jobs.map(outputJobSummary)
        };
    };

    const clearActiveLanes = () => {
        activeOutputKeys.clear();
    };

    const setProcessJob = fn => {
        processJob = fn;
        return processJob;
    };

    const getActiveLanes = () => Array.from(activeOutputKeys);

    return {
        readOutputJobs,
        readOutputJob,
        outputJobKey,
        outputJobSummary,
        writeOutputJobs,
        appendOutputJob,
        updateOutputJob,
        normalizeOutputJobs,
        activeOutputJobs,
        currentBusyState,
        feedHermesOutput,
        clearActiveLanes,
        setProcessJob,
        getActiveLanes
    };
};

module.exports = {
    createOutputQueue
};
