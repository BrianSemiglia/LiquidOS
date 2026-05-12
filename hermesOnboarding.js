(() => {
    window.createHermesOnboarding = ({ refreshStatus, globalStatus }) => {
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
            agents: []
        };

        const render = () => {
            const agents = onboardingState.agents || [];
            const codex = agents.find(agent => agent.id === 'codex') || { installed: false };
            const claude = agents.find(agent => agent.id === 'claude-code') || { installed: false };

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
                            refreshStatus().catch(() => {});
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
                        agents: Array.isArray(result?.agents) ? result.agents : []
                    };
                    render();
                })
                .catch(() => {
                    onboardingState = {
                        hermesConfigured: false,
                        agents: []
                    };
                    render();
                });

        return {
            probe,
            render
        };
    };
})();
