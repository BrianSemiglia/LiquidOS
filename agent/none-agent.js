// The no-op agent. Boots the harness with no working runtime: static
// rendering, services, and view.json watching all run, but a dispatched
// prompt rejects loudly (callbacks can't recurse, smoke tests stay honest).
// Passed by path like any other agent — there are no built-in kinds.

const NoneAgent = () => ({
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
    run: () => Promise.reject(new Error('No agent is configured.'))
});

module.exports = { NoneAgent };
