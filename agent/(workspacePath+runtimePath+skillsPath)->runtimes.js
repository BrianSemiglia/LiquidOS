const fs = require('fs');
const path = require('path');
const { writeAgentSystemPrompt } = require('./system-prompt');

// An agent is a script passed by path on the command line. The module exports
// a factory (a bare function, a `default`, or a single `*Agent` export) that
// returns the runtime object. The only required fields are `label` (the
// user-facing name, which is also the identity used to select and persist the
// active agent) and `run`; every lifecycle hook is optional. There are no
// built-in kinds and no central registry — the server is handed the array of
// scripts to load, real agents and test stubs alike.
const loadAgent = scriptPath => {
    const resolved = path.resolve(scriptPath);
    let mod;
    try { mod = require(resolved); }
    catch (error) { throw new Error(`could not load agent script ${scriptPath}: ${error.message}`); }

    const exportsObj = typeof mod === 'function' ? { default: mod } : (mod || {});
    const factory = exportsObj.default
        || (Object.entries(exportsObj).find(([name, value]) => typeof value === 'function' && /Agent$/.test(name)) || [])[1]
        || Object.values(exportsObj).find(value => typeof value === 'function');
    if (typeof factory !== 'function') {
        throw new Error(`agent script exports no factory function: ${scriptPath}`);
    }

    const runtime = factory();
    if (!runtime || typeof runtime.label !== 'string' || !runtime.label.trim()) {
        throw new Error(`agent script has no string \`label\`: ${scriptPath}`);
    }
    if (typeof runtime.run !== 'function') {
        throw new Error(`agent \`${runtime.label}\` has no run(): ${scriptPath}`);
    }
    return runtime;
};

// runtimePath is the workspace. Each agent materializes its discovery
// dir (`.claude/`, `.codex/`, `.hermes/`, `.pi/`, `.agents/`) directly
// inside the workspace so launching the agent with the workspace as CWD
// is enough — no separate Application Support runtime tree.
const createRuntimes = ({
    agentScripts = [],
    runtimePath,
    skillsPath
} = {}) => {
    if (!runtimePath || !skillsPath) {
        throw new Error('createRuntimes requires runtimePath and skillsPath');
    }
    if (!Array.isArray(agentScripts) || agentScripts.length === 0) {
        throw new Error('createRuntimes requires at least one agent script');
    }

    const runtimePromptPath = path.join(runtimePath, 'AGENTS.md');

    const runtimes = agentScripts.map(loadAgent);
    const seen = new Set();
    for (const runtime of runtimes) {
        if (seen.has(runtime.label)) {
            throw new Error(`duplicate agent label: ${runtime.label} (labels are identities; each must be unique)`);
        }
        seen.add(runtime.label);
    }

    const ownedRuntimePaths = () =>
        runtimes.flatMap(runtime =>
            typeof runtime?.runtimePaths === 'function'
                ? runtime.runtimePaths({ runtimePath }) || []
                : []
        );

    const materializeRuntime = () => {
        if (!fs.existsSync(skillsPath)) {
            return false;
        }

        // Only sweep the per-agent discovery dirs (.claude, .codex, etc.)
        // — not the workspace itself, which holds canvases and the user's
        // data.
        ownedRuntimePaths().forEach(p =>
            fs.rmSync(p, { recursive: true, force: true })
        );

        runtimes.forEach(runtime => {
            if (runtime && typeof runtime.materializeRuntime === 'function') {
                runtime.materializeRuntime({
                    runtimePath,
                    skillsPath
                });
            }
        });

        // The agent runs with the workspace as its cwd, and skill instructions
        // use workspace-relative paths (`node skills/testing/scripts/...`,
        // `bash skills/component/scripts/...`). The materialized, app-baked
        // skills live in the per-agent discovery dirs above; link a
        // workspace-root `skills/` to one of them so those commands resolve
        // directly — no second physical copy of the tree, no agent hunting for
        // where the scripts live. Relative target so a copied workspace (a test
        // sandbox) still resolves within itself.
        const skillsLink = path.join(runtimePath, 'skills');
        const linkTarget = ownedRuntimePaths()
            .map(p => path.join(p, 'skills'))
            .find(s => fs.existsSync(s));
        try {
            // `skills/` is runtime-managed and gitignored, so replacing a stale
            // copy or old link is safe; it never holds the user's canvas data.
            if (fs.lstatSync(skillsLink, { throwIfNoEntry: false })) {
                fs.rmSync(skillsLink, { recursive: true, force: true });
            }
            if (linkTarget) {
                fs.symlinkSync(path.relative(runtimePath, linkTarget), skillsLink, 'dir');
            }
        } catch {
            // best-effort; the per-agent discovery dirs still hold the skills
        }

        writeAgentSystemPrompt({ filePath: runtimePromptPath });

        return true;
    };

    const refreshRuntime = () => {
        materializeRuntime();
        process.env.LIQUIDOS_AGENT_RUNTIME_PATH = runtimePath;
    };

    const configureHosts = ({ output, status } = {}) => {
        runtimes.forEach(runtime => {
            if (typeof runtime.configureHost === 'function') {
                runtime.configureHost({ output, status });
            }
        });
    };

    return {
        runtimes,
        runtimePath,
        runtimePromptPath,
        refreshRuntime,
        configureHosts
    };
};

module.exports = {
    createRuntimes
};
