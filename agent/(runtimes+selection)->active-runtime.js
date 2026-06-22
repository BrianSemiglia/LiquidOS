// An agent's `label` is its identity — the value shown to the user, persisted
// in ui-state.json, and used to select/switch. Compared verbatim (trimmed, not
// lowercased) since labels carry caps and spaces ("No agent", "Claude Code").
const selectRuntime = ({ runtimes = [], selection = null } = {}) => {
    const normalizedLabel = String(selection || '').trim();
    const byLabel = new Map(runtimes.map(runtime => [runtime.label, runtime]));

    return byLabel.get(normalizedLabel) || runtimes[0] || null;
};

const createActiveRuntime = ({
    runtimes = [],
    selection = null
} = {}) => {
    const selected = () => selectRuntime({
        runtimes,
        selection
    });

    let active = selected();

    const activeRuntimeInstance = () => active || runtimes[0] || null;
    const activeKind = () => {
        const runtime = activeRuntimeInstance();
        return runtime ? runtime.label : null;
    };

    const snapshotRuntime = runtime => {
        const debug = runtime && typeof runtime.currentDebug === 'function'
            ? runtime.currentDebug()
            : null;

        return runtime ? {
            ...(debug || {}),
            kind: activeKind(),
            label: runtime.label || null
        } : null;
    };

    const currentDebug = () => {
        const runtime = activeRuntimeInstance();
        return runtime && typeof runtime.currentDebug === 'function'
            ? runtime.currentDebug()
            : null;
    };

    const select = nextSelection => {
        const normalized = String(nextSelection || '').trim();
        const nextRuntime = runtimes.find(runtime => runtime.label === normalized) || null;

        if (!nextRuntime) {
            return {
                ok: false,
                statusCode: 400,
                error: 'Unknown agent kind.'
            };
        }

        if (typeof nextRuntime.isInstalled === 'function' && !nextRuntime.isInstalled()) {
            return {
                ok: false,
                statusCode: 409,
                error: nextRuntime.label + ' is not installed on this machine.'
            };
        }

        const previousRuntime = activeRuntimeInstance();

        if (activeKind() !== normalized && previousRuntime && typeof previousRuntime.dispose === 'function') {
            try {
                previousRuntime.dispose();
            } catch (error) {
                // The caller handles logging when needed.
            }
        }

        active = selectRuntime({
            runtimes,
            selection: normalized
        });

        return {
            ok: true,
            agent: {
                kind: activeKind(),
                label: activeRuntimeInstance().label
            }
        };
    };

    const probe = () => {
        const agents = runtimes.map(runtime => ({
            id: runtime.label,
            label: runtime.label,
            installed: typeof runtime.isInstalled === 'function' ? runtime.isInstalled() : null,
            usable: true,
            command: runtime.command || null,
            provider: runtime.currentDebug ? runtime.currentDebug().provider || runtime.label : runtime.label,
            model: runtime.currentDebug ? runtime.currentDebug().model || null : null,
            status: runtime.currentDebug ? runtime.currentDebug().status || null : null
        }));

        return {
            agents,
            agentKind: activeKind(),
            agentChoices: agents,
            active: snapshotRuntime(activeRuntimeInstance())
        };
    };

    const preparePrompt = (prompt, options = {}) => {
        const runtime = activeRuntimeInstance();
        return runtime && typeof runtime.preparePrompt === 'function'
            ? runtime.preparePrompt(prompt, options)
            : prompt;
    };

    const initialize = options => {
        const runtime = activeRuntimeInstance();
        if (runtime && typeof runtime.initialize === 'function') {
            runtime.initialize(options);
        }
        return runtime;
    };

    const run = (prompt, context = {}) => {
        const runtime = activeRuntimeInstance();

        if (!runtime) {
            throw new Error('No agent runtime is available.');
        }

        if (typeof runtime.initialize === 'function') {
            runtime.initialize({ workingDirectory: context.workingDirectory });
        }

        return runtime.run(prompt, context);
    };

    return {
        runtimes,
        currentDebug,
        select,
        probe,
        preparePrompt,
        initialize,
        run,
        activeRuntime: activeRuntimeInstance,
        activeKind
    };
};

module.exports = {
    createActiveRuntime
};
