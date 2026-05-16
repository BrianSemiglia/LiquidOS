const createAgentProviders = ({ agents, workingDirectory, onStatus = () => {} }) => {
    const providers = Object.fromEntries(agents.map(agent => [agent.kind, agent]));
    const installationCache = new Map();
    let activeKind = null;
    let initializationToken = 0;

    const installed = provider => {
        if (!provider || typeof provider.isInstalled !== 'function') {
            return true;
        }

        if (!installationCache.has(provider.kind)) {
            installationCache.set(provider.kind, Boolean(provider.isInstalled()));
        }

        return installationCache.get(provider.kind);
    };

    activeKind = (agents.find(installed) || agents[0]).kind;

    const activeProvider = () => providers[activeKind] || agents[0];

    const providerSnapshot = provider => ({
        id: provider.kind,
        label: provider.label,
        installed: installed(provider),
        usable: installed(provider),
        command: provider.command || null,
        provider: provider.currentDebug ? provider.currentDebug().provider || provider.kind : provider.kind,
        model: provider.currentDebug ? provider.currentDebug().model || null : null,
        status: provider.currentDebug ? provider.currentDebug().status || null : null
    });

    const availableKinds = () => agents.map(providerSnapshot);

    const initializeProvider = provider => {
        const token = ++initializationToken;

        if (!provider || typeof provider.initialize !== 'function') {
            return;
        }

        if (!installed(provider)) {
            return;
        }

        onStatus({
            ...(provider.currentDebug ? provider.currentDebug() : {}),
            kind: provider.kind,
            label: provider.label,
            status: 'starting'
        });

        setImmediate(() => {
            if (token !== initializationToken || provider !== activeProvider()) {
                return;
            }

            try {
                provider.initialize({ workingDirectory });
                onStatus({
                    ...(provider.currentDebug ? provider.currentDebug() : {}),
                    kind: provider.kind,
                    label: provider.label,
                    status: provider.currentDebug ? provider.currentDebug().status || 'waiting' : 'waiting'
                });
            } catch (error) {
                onStatus({
                    ...(provider.currentDebug ? provider.currentDebug() : {}),
                    kind: provider.kind,
                    label: provider.label,
                    status: 'error',
                    error: error.message
                });
            }
        });
    };

    const probe = () => ({
        agents: availableKinds(),
        agentKind: activeKind,
        agentChoices: availableKinds(),
        active: providerSnapshot(activeProvider())
    });

    const setActiveKind = kind => {
        const normalized = String(kind || '').trim().toLowerCase();

        if (!providers[normalized]) {
            return {
                ok: false,
                statusCode: 400,
                error: 'Unknown agent kind.'
            };
        }

        if (!installed(providers[normalized])) {
            return {
                ok: false,
                statusCode: 409,
                error: providers[normalized].label + ' is not installed on this machine.'
            };
        }

        initializationToken += 1;

        if (activeKind !== normalized && providers[activeKind] && typeof providers[activeKind].dispose === 'function') {
            try {
                providers[activeKind].dispose();
            } catch (error) {
                onStatus({
                    ...(providers[activeKind].currentDebug ? providers[activeKind].currentDebug() : {}),
                    kind: providers[activeKind].kind,
                    label: providers[activeKind].label,
                    status: 'error',
                    error: error.message
                });
            }
        }

        activeKind = normalized;
        initializeProvider(providers[activeKind]);

        return {
            ok: true,
            agent: {
                kind: activeKind,
                label: providers[activeKind].label
            }
        };
    };

    initializeProvider(activeProvider());

    return {
        availableKinds,
        probe,
        setActiveKind,
        activeKind: () => activeKind,
        activeProvider,
        preparePrompt: (prompt, options = {}) => activeProvider() && typeof activeProvider().preparePrompt === 'function'
            ? activeProvider().preparePrompt(prompt, options)
            : prompt,
        runActive: (prompt, options = {}) => activeProvider().run(prompt, options)
    };
};

module.exports = {
    createAgentProviders
};
