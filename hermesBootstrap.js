const { spawnSync } = require('child_process');

const createHermesBootstrap = ({ root, agentCommand }) => {
    const localAgentDefinitions = [
        {
            id: 'claude-code',
            label: 'Claude Code',
            command: 'claude',
            provider: 'anthropic',
            model: 'anthropic/claude-sonnet-4.6'
        },
        {
            id: 'codex',
            label: 'Codex',
            command: 'codex',
            provider: 'openai-codex',
            model: 'openai/gpt-5.3-codex'
        }
    ];

    const localAgentDefinitionById = new Map(localAgentDefinitions.map(definition => [definition.id, definition]));
    let selectedHermesBackend = null;

    const commandExists = command =>
        spawnSync('which', [command], {
            cwd: root,
            env: process.env,
            encoding: 'utf8'
        }).status === 0;

    const readHermesConfiguredModel = () => {
        if (!commandExists(agentCommand)) {
            return {
                configured: false,
                provider: '',
                model: '',
                raw: ''
            };
        }

        const result = spawnSync(agentCommand, ['config', 'show'], {
            cwd: root,
            env: process.env,
            encoding: 'utf8',
            maxBuffer: 2_000_000
        });
        const raw = String(result.stdout || '');
        const modelLine = raw.split(/\r?\n/).find(line => line.includes('Model:')) || '';
        const providerMatch = modelLine.match(/'provider':\s*'([^']*)'/);
        const modelMatch = modelLine.match(/'default':\s*'([^']*)'/);

        return {
            configured: result.status === 0 && Boolean((modelMatch ? modelMatch[1] : '').trim()),
            provider: providerMatch ? providerMatch[1] : '',
            model: modelMatch ? modelMatch[1] : '',
            raw
        };
    };

    const currentHermesBootstrapState = () => {
        const configuredModel = readHermesConfiguredModel();

        return {
            configured: configuredModel.configured || Boolean(selectedHermesBackend),
            provider: configuredModel.configured
                ? configuredModel.provider || ''
                : selectedHermesBackend?.provider || '',
            model: configuredModel.configured
                ? configuredModel.model || ''
                : selectedHermesBackend?.model || ''
        };
    };

    const selectedHermesLaunchArgs = () => {
        const state = currentHermesBootstrapState();

        return state.configured && state.provider && state.model
            ? ['--provider', state.provider, '--model', state.model]
            : [];
    };

    const selectedHermesLaunchEnv = () => {
        const state = currentHermesBootstrapState();

        return state.configured && state.provider && state.model
            ? {
                HERMES_INFERENCE_PROVIDER: state.provider,
                HERMES_INFERENCE_MODEL: state.model
            }
            : {};
    };

    const selectHermesBackend = agentId => {
        const definition = localAgentDefinitionById.get(String(agentId || ''));

        if (!definition) {
            return {
                ok: false,
                statusCode: 400,
                error: 'Unknown agent selection.'
            };
        }

        if (!commandExists(definition.command)) {
            return {
                ok: false,
                statusCode: 409,
                error: definition.label + ' is not installed on this machine.'
            };
        }

        selectedHermesBackend = {
            id: definition.id,
            label: definition.label,
            provider: definition.provider,
            model: definition.model
        };

        return {
            ok: true,
            selected: selectedHermesBackend,
            hermes: currentHermesBootstrapState()
        };
    };

    const probeLocalAgents = () => {
        const hermesState = currentHermesBootstrapState();

        return {
            hermes: {
                installed: commandExists(agentCommand),
                usable: commandExists(agentCommand),
                command: agentCommand,
                configured: hermesState.configured,
                provider: hermesState.provider || null,
                model: hermesState.model || null
            },
            agents: localAgentDefinitions.map(definition => ({
                id: definition.id,
                label: definition.label,
                command: definition.command,
                installed: commandExists(definition.command),
                usable: commandExists(definition.command),
                provider: definition.provider,
                model: definition.model
            }))
        };
    };

    return {
        localAgentDefinitions,
        probeLocalAgents,
        selectHermesBackend,
        readHermesConfiguredModel,
        currentHermesBootstrapState,
        selectedHermesLaunchArgs,
        selectedHermesLaunchEnv,
        commandExists
    };
};

module.exports = {
    createHermesBootstrap
};
