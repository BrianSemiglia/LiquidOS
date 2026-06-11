const fs = require('fs');
const path = require('path');
const { writeAgentSystemPrompt } = require('./system-prompt');
const { HermesAgent } = require('./(skillsPath+runtimePath)->hermes-runtime');
const { PiAgent } = require('./(skillsPath+runtimePath)->pi-runtime');
const { CodexAgent } = require('./(skillsPath+runtimePath)->codex-runtime');
const { ClaudeCodeAgent } = require('./(skillsPath+runtimePath)->claude-runtime');
// Test agents — one per probe scenario, each with its own kind name.
// First-class runtimes from the dispatch loop's perspective; the only
// difference is they record into a known file instead of calling an LLM.
const { CallbackDispatchTestAgent } = require('./test/callback-dispatch-agent');
const { CanvasBuildTestAgent } = require('./test/canvas-build-test-agent');
const { ComponentRepairTestAgent } = require('./test/component-repair-test-agent');
const { ComponentBuildTestAgent } = require('./test/component-build-test-agent');
const { CanvasDamagedRepairTestAgent } = require('./test/canvas-damaged-repair-test-agent');
const { ComponentRuntimeRepairTestAgent } = require('./test/component-runtime-repair-test-agent');
const { PromptBarSingleDispatchTestAgent } = require('./test/prompt-bar-single-dispatch-test-agent');
const { CanvasRepairTestAgent } = require('./test/canvas-repair-test-agent');
const { PromptBarTestAgent } = require('./test/prompt-bar-test-agent');
const { InstallBuildTestAgent } = require('./test/install-build-test-agent');
const { CrossCanvasPersistenceTestAgent } = require('./test/cross-canvas-persistence-test-agent');
const { LqpatchStreamStubAgent } = require('./test/lqpatch-stream-stub-agent');
const { ServiceRewriteStubAgent } = require('./test/service-rewrite-stub-agent');

// NoneAgent is for runs that should not have a working agent — sandbox boots
// for smoke tests, recursion guards, anything where callbacks should fail
// loudly rather than dispatching a real prompt. Callbacks will reject; static
// rendering, services, and view.json watching still work.
const NoneAgent = () => ({
    kind: 'none',
    label: 'No agent',
    command: null,
    configureHost: () => {},
    isInstalled: () => true,
    initialize: () => {},
    dispose: () => {},
    currentDebug: () => ({ status: 'no agent configured' }),
    runtimePaths: () => [],
    materializeRuntime: () => {},
    preparePrompt: prompt => prompt,
    run: () => Promise.reject(new Error('No agent is configured (--agent none).'))
});

// runtimePath is the workspace. Each agent materializes its discovery
// dir (`.claude/`, `.codex/`, `.hermes/`, `.pi/`, `.agents/`) directly
// inside the workspace so launching the agent with the workspace as CWD
// is enough — no separate Application Support runtime tree.
const createRuntimes = ({
    runtimePath,
    skillsPath
} = {}) => {
    if (!runtimePath || !skillsPath) {
        throw new Error('createRuntimes requires runtimePath and skillsPath');
    }

    const runtimePromptPath = path.join(runtimePath, 'AGENTS.md');

    const runtimes = [
        HermesAgent(),
        PiAgent(),
        CodexAgent(),
        ClaudeCodeAgent(),
        NoneAgent(),
        CallbackDispatchTestAgent(),
        CanvasBuildTestAgent(),
        ComponentRepairTestAgent(),
        ComponentBuildTestAgent(),
        CanvasDamagedRepairTestAgent(),
        ComponentRuntimeRepairTestAgent(),
        PromptBarSingleDispatchTestAgent(),
        CanvasRepairTestAgent(),
        PromptBarTestAgent(),
        InstallBuildTestAgent(),
        CrossCanvasPersistenceTestAgent(),
        LqpatchStreamStubAgent(),
        ServiceRewriteStubAgent()
    ];

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

        writeAgentSystemPrompt({ filePath: runtimePromptPath });

        return true;
    };

    const refreshRuntime = () => {
        materializeRuntime();
        process.env.LIQUIDOS_AGENT_RUNTIME_PATH = runtimePath;
    };

    const configureHosts = ({ output, status } = {}) => {
        runtimes.forEach(runtime => {
            runtime.configureHost({
                output,
                status
            });
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
