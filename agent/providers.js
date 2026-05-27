const createAgentProviders = ({ agents, workingDirectory, selectedKind: initialKind = null, onStatus = () => {} }) => {
    const providers = Object.fromEntries(agents.map(agent => [agent.kind, agent]));
    const installationCache = new Map();
    let selectedKind = null;
    let initializationToken = 0;
    const initializedKinds = new Set();

    const installed = (provider, { refresh = false } = {}) => {
        if (!provider || typeof provider.isInstalled !== 'function') {
            return true;
        }

        if (refresh || !installationCache.has(provider.kind)) {
            installationCache.set(provider.kind, Boolean(provider.isInstalled()));
        }

        return installationCache.get(provider.kind);
    };

    const cachedInstalled = provider => {
        if (!provider || typeof provider.isInstalled !== 'function') {
            return true;
        }

        return installationCache.has(provider.kind) ? installationCache.get(provider.kind) : null;
    };

    selectedKind = providers[initialKind] ? initialKind : (agents[0] || {}).kind;

    const selectedProvider = () => providers[selectedKind] || agents[0];

    const providerSnapshot = (provider, { checkInstalled = false } = {}) => ({
        id: provider.kind,
        label: provider.label,
        installed: checkInstalled ? installed(provider, { refresh: true }) : cachedInstalled(provider),
        usable: checkInstalled ? installed(provider, { refresh: true }) : cachedInstalled(provider) !== false,
        command: provider.command || null,
        provider: provider.currentDebug ? provider.currentDebug().provider || provider.kind : provider.kind,
        model: provider.currentDebug ? provider.currentDebug().model || null : null,
        status: provider.currentDebug ? provider.currentDebug().status || null : null
    });

    const availableKinds = (options = {}) => agents.map(provider => providerSnapshot(provider, options));

    const initializeProvider = provider => {
        const token = ++initializationToken;

        if (!provider || typeof provider.initialize !== 'function') {
            return;
        }

        if (!installed(provider, { refresh: true }) || initializedKinds.has(provider.kind)) {
            return;
        }

        onStatus({
            ...(provider.currentDebug ? provider.currentDebug() : {}),
            kind: provider.kind,
            label: provider.label,
            status: 'starting'
        });

        setImmediate(() => {
            if (token !== initializationToken || provider !== selectedProvider()) {
                return;
            }

            try {
                provider.initialize({ workingDirectory });
                initializedKinds.add(provider.kind);
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

    const probe = (options = {}) => ({
        agents: availableKinds(options),
        agentKind: selectedKind,
        agentChoices: availableKinds(options),
        selected: providerSnapshot(selectedProvider(), options)
    });

    const setSelectedKind = kind => {
        const normalized = String(kind || '').trim().toLowerCase();

        if (!providers[normalized]) {
            return {
                ok: false,
                statusCode: 400,
                error: 'Unknown agent kind.'
            };
        }

        if (!installed(providers[normalized], { refresh: true })) {
            return {
                ok: false,
                statusCode: 409,
                error: providers[normalized].label + ' is not installed on this machine.'
            };
        }

        initializationToken += 1;

        if (selectedKind !== normalized && providers[selectedKind] && typeof providers[selectedKind].dispose === 'function') {
            try {
                providers[selectedKind].dispose();
            } catch (error) {
                onStatus({
                    ...(providers[selectedKind].currentDebug ? providers[selectedKind].currentDebug() : {}),
                    kind: providers[selectedKind].kind,
                    label: providers[selectedKind].label,
                    status: 'error',
                    error: error.message
                });
            }
        }

        selectedKind = normalized;

        return {
            ok: true,
            agent: {
                kind: selectedKind,
                label: providers[selectedKind].label
            }
        };
    };

    return {
        availableKinds,
        probe,
        setSelectedKind,
        selectedKind: () => selectedKind,
        selectedProvider,
        preparePrompt: (prompt, options = {}) => selectedProvider() && typeof selectedProvider().preparePrompt === 'function'
            ? selectedProvider().preparePrompt(prompt, options)
            : prompt,
        runSelected: (prompt, options = {}) => {
            initializeProvider(selectedProvider());
            return selectedProvider().run(prompt, options);
        }
    };
};

module.exports = {
    createAgentProviders
};
