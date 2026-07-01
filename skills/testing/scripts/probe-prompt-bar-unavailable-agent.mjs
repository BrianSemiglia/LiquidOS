//
// probe-prompt-bar-unavailable-agent.mjs
//
// You can only send a prompt to an agent that's actually there. When the
// active agent is unavailable — its CLI isn't installed on the machine — the
// prompt bar has nowhere to dispatch, so its text field and Send button must
// be disabled: grayed out and inert, exactly what a person perceives for a
// control they can't use. Pick an installed agent and the bar comes back to
// life.
//
// The Uninstalled Stub is listed first, so it boots as the default-active
// agent (the active runtime falls back to the first agent when ui-state.json
// names none). Stub A is installed and offered alongside it, so the probe can
// switch to a live agent and prove the bar re-enables — a build that disabled
// the bar unconditionally, or never disabled it, would fail one half.
//
// FLAG: like probe-agent-uninstalled-grayed.mjs, "disabled" is asserted by the
// control's actual disabled state — the browser's native grayed-out,
// unclickable rendering — which is precisely what a person sees, rather than by
// scraping text (a disabled control shows no distinguishing string).
//
// Run it:  node run-probe.mjs probe-prompt-bar-unavailable-agent.mjs
//

export const fixture = './probe-prompt-bar-unavailable-agent.liquidos';
// Uninstalled Stub first → it's the default-active agent, and it's not
// installed. Stub A is the installed agent we switch to for the enabled case.
export const agent = [
    'agent/test/uninstalled-stub-agent.js',
    'agent/test/agent-switch-stub-a-agent.js',
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    const promptField = page.getByRole('textbox', { name: 'Prompt' });
    const sendButton = page.getByRole('button', { name: 'Send' });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await promptField.waitFor({ timeout: 20000 });
    // Let loadAgentChoices settle the picker/bar from /agents/probe.
    await sleep(1500);

    // The active agent is the Uninstalled Stub — nothing to send to, so both
    // the field and the button are dead.
    if (!(await promptField.isDisabled())) {
        throw new Error('prompt field is enabled while the active agent is unavailable — it should be disabled');
    }
    if (!(await sendButton.isDisabled())) {
        throw new Error('Send button is enabled while the active agent is unavailable — it should be disabled');
    }

    // Switch to Stub A, an installed agent, through the always-visible picker.
    await page.waitForSelector('#agent-select', { timeout: 20000 });
    await page.selectOption('#agent-select', 'Stub A');

    // The switch is eventually-consistent: the dropdown writes ui-state.json,
    // the harness swaps the runtime and broadcasts agent-mode, and only then
    // does loadAgentChoices re-enable the bar. Wait for that, don't race it.
    await page.waitForFunction(
        () => document.getElementById('global-text') && !document.getElementById('global-text').disabled,
        { timeout: 15000 }
    ).catch(() => { throw new Error('prompt field stayed disabled after switching to an installed agent'); });

    // With a live agent and something typed, Send comes back too.
    await promptField.fill('hello');
    if (await sendButton.isDisabled()) {
        throw new Error('Send button stayed disabled after switching to an installed agent and typing');
    }

    console.log('prompt bar disabled while the active agent is unavailable; re-enabled after switching to an installed agent');
};
