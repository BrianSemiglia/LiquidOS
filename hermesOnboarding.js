(() => {
    window.createHermesOnboarding = ({ globalStatus }) => {
        const agentSetupBackdrop = document.getElementById('agent-setup-backdrop');
        const agentSetup = document.getElementById('agent-setup');

        if (!agentSetupBackdrop || !agentSetup) {
            return {
                probe: async () => {},
                render: () => {}
            };
        }

        let onboardingState = {
            hermesConfigured: false,
            agents: [],
            agentKind: 'hermes',
            agentChoices: []
        };

        const render = () => {
            const agents = onboardingState.agents || [];
            const codex = agents.find(agent => agent.id === 'codex') || { installed: false };
            const claude = agents.find(agent => agent.id === 'claude-code') || { installed: false };

            if (onboardingState.agentKind === 'codex') {
                agentSetupBackdrop.dataset.open = 'false';
                agentSetup.innerHTML = '';
                return;
            }

            if (onboardingState.hermesConfigured) {
                agentSetupBackdrop.dataset.open = 'false';
                agentSetup.innerHTML = '';
                return;
            }

            agentSetupBackdrop.dataset.open = 'true';
            agentSetup.innerHTML = `
                <h1>Hermes needs a model</h1>
                <p>Hermes is not configured yet. Use Codex CLI or Claude Code if you already have one installed, then pick the backend Hermes should start with.</p>
                <div class="agent-picker">
                    <button type="button" data-agent-id="codex"${codex.installed ? '' : ' disabled'}>Codex</button>
                    <button type="button" data-agent-id="claude-code"${claude.installed ? '' : ' disabled'}>Claude Code</button>
                </div>
            `;

            agentSetup.querySelectorAll('[data-agent-id]').forEach(button => {
                button.addEventListener('click', () => {
                    const agentId = button.dataset.agentId || '';
                    const agent = agents.find(entry => entry.id === agentId);

                    if (!agent || !agent.installed) {
                        return;
                    }

                    agentSetup.querySelectorAll('button').forEach(nextButton => {
                        nextButton.disabled = true;
                    });

                    fetch('/agents/select', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ id: agentId })
                    })
                        .then(response => response.ok ? response.json() : Promise.reject(new Error('Could not select Hermes backend')))
                        .then(result => {
                            onboardingState.hermesConfigured = Boolean(result?.hermes?.configured);
                            agentSetupBackdrop.dataset.open = 'false';
                            agentSetup.innerHTML = '';
                        })
                        .catch(error => {
                            globalStatus.className = 'global-status error';
                            globalStatus.textContent = 'Error: ' + error.message;
                            render();
                        });
                });
            });
        };

        const probe = () =>
            fetch('/agents/probe', { cache: 'no-store' })
                .then(response => response.ok ? response.json() : Promise.reject(new Error('Could not probe agents')))
                .then(result => {
                    onboardingState = {
                        hermesConfigured: Boolean(result?.hermes?.configured),
                        agents: Array.isArray(result?.agents) ? result.agents : [],
                        agentKind: typeof result?.agentKind === 'string' ? result.agentKind : 'hermes',
                        agentChoices: Array.isArray(result?.agentChoices) ? result.agentChoices : []
                    };
                    render();
                })
                .catch(() => {
                    onboardingState = {
                        hermesConfigured: false,
                        agents: [],
                        agentKind: 'hermes',
                        agentChoices: []
                    };
                    render();
                });

        return {
            probe,
            render
        };
    };
})();
