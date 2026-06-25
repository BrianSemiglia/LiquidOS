//
// probe-agent-uninstalled-grayed.mjs
//
// An agent can be offered in the picker without being installed: its CLI
// binary is absent on the machine. The picker still lists it as a choice,
// but it must appear grayed out and unpickable — a disabled <option> — so
// the user can see the runtime exists yet understands they can't select it.
//
// Two stubs back this: an installed one (Stub A, isInstalled() → true) that
// boots active, and an uninstalled one (Uninstalled Stub, isInstalled() →
// false). The probe opens the debug view to reveal the picker, then asserts
// the installed choice is selectable while the uninstalled choice is present
// but disabled. Having both proves the test discriminates: a build that
// disabled nothing — or everything — would fail.
//
// FLAG: like probe-agent-picker-debug-only.mjs, a <select>'s option text is
// not reliably in document.body.innerText across engines, and "grayed out"
// is exactly the browser's native rendering of a disabled <option>. So the
// grayed state is asserted by the option's actual disabled state — precisely
// what a person perceives — rather than by scraping text.
//
// Run it:  node run-probe.mjs probe-agent-uninstalled-grayed.mjs
//

export const fixture = './probe-agent-uninstalled-grayed.liquidos';
// Stub A is installed and listed first, so it's the default-active agent;
// the Uninstalled Stub is offered alongside it but reports not-installed.
export const agent = [
    'agent/test/agent-switch-stub-a-agent.js',
    'agent/test/uninstalled-stub-agent.js',
];

import { LABEL as UNINSTALLED_LABEL } from '../../../agent/test/uninstalled-stub-agent.js';

const INSTALLED_LABEL = 'Stub A';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    // Read an option's rendered state straight from the <select> by its
    // visible label: does it exist, and is it disabled (grayed out)?
    const optionState = (label) => page.evaluate((text) => {
        const sel = document.getElementById('agent-select');
        if (!sel) return null;
        const option = [...sel.options].find(o => o.textContent.trim() === text);
        return option ? { present: true, disabled: option.disabled } : { present: false };
    }, label);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });

    // The picker is a debug-only control, so open the debug view (the same
    // toggle the Mac app's View menu drives) before reaching for it.
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
    await page.evaluate(() => window.liquidos.setDebugOpen(true));
    await page.waitForSelector('#agent-select', { timeout: 20000 });
    // Let loadAgentChoices rebuild the <option>s from /agents/probe.
    await sleep(1500);

    // The uninstalled agent is offered as a choice...
    const uninstalled = await optionState(UNINSTALLED_LABEL);
    if (!uninstalled || !uninstalled.present) {
        throw new Error('"' + UNINSTALLED_LABEL + '" is not offered in the picker at all — it should be listed even when not installed');
    }
    // ...but grayed out / unpickable.
    if (!uninstalled.disabled) {
        throw new Error('"' + UNINSTALLED_LABEL + '" is selectable — an uninstalled agent should appear grayed out (disabled) in the picker');
    }

    // The installed agent, by contrast, is present and selectable — proving
    // the picker disables only what's actually missing.
    const installed = await optionState(INSTALLED_LABEL);
    if (!installed || !installed.present) {
        throw new Error('"' + INSTALLED_LABEL + '" missing from the picker — the installed agent should be listed');
    }
    if (installed.disabled) {
        throw new Error('"' + INSTALLED_LABEL + '" is grayed out, but it is installed and should be selectable');
    }

    console.log('uninstalled agent listed but grayed out (disabled); installed agent selectable');
};
