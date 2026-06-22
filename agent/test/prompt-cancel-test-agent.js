// Test agent for the prompt-cancel probe.
//
// Models a job the user cancels mid-flight, then the undo follow-up:
//   - First prompt ("do the task"): add the pre-staged probe-built component
//     to index.json (the started work becomes visible as "BUILT"), then spawn
//     a real child process and hang on it — exactly like a real provider with
//     a live agent process still running. Its pid is reported via host.status,
//     so the queue/job layer can cancel the job by killing the process tree
//     (the production path — there's no in-process cancel hook).
//   - The server then enqueues an undo prompt on the same scope. This agent
//     recognizes it and reverts index.json to empty, so "BUILT" disappears —
//     proving the cancel stopped the job and re-prompted it to undo.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let host = { output: () => {}, status: () => {} };
const KIND = 'prompt-cancel-test';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const isUndoPrompt = (prompt) => /canceled your previous task/i.test(String(prompt || ''));
const isQueuedMarkerPrompt = (prompt) => /queue a marker/i.test(String(prompt || ''));

const PromptCancelTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Prompt cancel (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Prompt cancel (test)', command: null,
        configureHost: (next) => { host = { output: typeof next?.output === 'function' ? next.output : host.output, status: typeof next?.status === 'function' ? next.status : host.status }; },
        isInstalled: () => true,
        initialize: ({ workingDirectory } = {}) => setStatus({ status: 'waiting', cwd: workingDirectory || null }),
        dispose: () => {},
        currentDebug: () => ({ ...currentDebug }),
        preparePrompt: (prompt) => prompt,
        runtimePaths: () => [],
        materializeRuntime: () => {},
        run: (prompt, context = {}) => new Promise((resolve, reject) => {
            const workingDirectory = context.workingDirectory || context.canvasPath;
            if (!workingDirectory) { reject(new Error(KIND + ': run requires workingDirectory')); return; }
            const canvasFolder = (extractScope(prompt) || '').replace(/\/$/, '');
            if (!canvasFolder) { reject(new Error(KIND + ': could not extract canvas scope')); return; }
            const indexPath = path.join(canvasFolder, 'index.json');

            if (isQueuedMarkerPrompt(prompt)) {
                // A second job queued behind the canceled one. It reconciles
                // the canvas to a distinct marker ("QUEUED") and completes.
                // The cancel's undo resets the canvas to empty, so this marker
                // survives only if the undo runs BEFORE this queued job — which
                // is exactly the ordering the cancel insert must guarantee.
                setStatus({ status: 'running', cwd: workingDirectory });
                try {
                    fs.writeFileSync(indexPath, JSON.stringify({ components: ['components/probe-queued/component.html'] }, null, 2) + '\n');
                    setStatus({ status: 'waiting' });
                    resolve('queued marker placed');
                } catch (error) {
                    setStatus({ status: 'failed', error: error.message });
                    reject(error);
                }
                return;
            }

            if (isUndoPrompt(prompt)) {
                // The undo: take the started work back off the canvas, so
                // "BUILT" leaves the screen. The agent only does this when it's
                // re-prompted to undo — a non-undo prompt falls through to the
                // task branch and puts the work back — so the work disappearing
                // is what proves the cancel re-prompted it to undo.
                setStatus({ status: 'running', cwd: workingDirectory });
                try {
                    fs.writeFileSync(indexPath, JSON.stringify({ components: [] }, null, 2) + '\n');
                    setStatus({ status: 'waiting' });
                    resolve('undone');
                } catch (error) {
                    setStatus({ status: 'failed', error: error.message });
                    reject(error);
                }
                return;
            }

            // The task: show the started work, then hold on a real child
            // process until the server cancels the job by killing it.
            try {
                fs.writeFileSync(indexPath, JSON.stringify({ components: ['components/probe-built/component.html'] }, null, 2) + '\n');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
                return;
            }

            const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
            // Report the pid like a real provider — this is what the cancel
            // path kills.
            setStatus({ status: 'running', pid: child.pid, cwd: workingDirectory });
            child.on('close', () => {
                setStatus({ status: 'waiting' });
                reject(new Error(KIND + ': agent process stopped'));
            });
            child.on('error', (error) => {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            });
        })
    };
};

module.exports = { PromptCancelTestAgent };
