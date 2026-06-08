// Test agent for the install-triggered build probe.
//
// POST /share (install) enqueues a "Build this canvas and its components."
// job scoped to the newly-installed canvas. A real agent would read each
// scaffolded component's feature-requirements.txt and rewrite its
// view.json with the actual UI. This agent simulates that minimally:
// for every component referenced from input.json, replace view.json's
// html with a sentinel <p data-install-build-marker>built</p> so the
// probe can assert the agent ran and the result reached the DOM.

const fs = require('fs');
const path = require('path');

let host = { output: () => {}, status: () => {} };
const KIND = 'install-build-test';

const extractScope = (prompt) => {
    const m = String(prompt || '').match(/^Scope:\s*\n?\s*(\S[^\n]*)/m);
    return m ? m[1].trim() : '';
};

const InstallBuildTestAgent = () => {
    const currentDebug = { kind: KIND, label: 'Install build (test)', command: null, status: 'waiting', provider: 'test', model: null, source: 'in-process' };
    const setStatus = (next) => { Object.assign(currentDebug, next, { at: new Date().toISOString() }); host.status({ ...currentDebug }); };
    return {
        kind: KIND, label: 'Install build (test)', command: null,
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
            if (!canvasFolder) {
                reject(new Error(KIND + ': could not extract canvas scope from prompt'));
                return;
            }
            setStatus({ status: 'running', cwd: workingDirectory });
            try {
                const inputPath = path.join(canvasFolder, 'input.json');
                const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
                const entries = Array.isArray(input.components) ? input.components : [];
                for (const entry of entries) {
                    // entry is "components/<name>/component.html"; the
                    // component folder is its dirname.
                    const componentDir = path.join(canvasFolder, path.dirname(String(entry)));
                    const viewJsonPath = path.join(componentDir, 'view.json');
                    if (!fs.existsSync(viewJsonPath)) continue;
                    fs.writeFileSync(viewJsonPath, JSON.stringify({
                        html: '<p data-install-build-marker="true">built</p>'
                    }, null, 2) + '\n');
                }
                setStatus({ status: 'waiting' });
                resolve('ok');
            } catch (error) {
                setStatus({ status: 'failed', error: error.message });
                reject(error);
            }
        })
    };
};

module.exports = { InstallBuildTestAgent };
