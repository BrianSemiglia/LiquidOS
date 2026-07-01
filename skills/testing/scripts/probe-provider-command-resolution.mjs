//
// probe-provider-command-resolution.mjs
//
// One check per agent provider (Hermes, Claude Code, Pi) that install-detection
// works end to end — through the real app, asserted at the agent picker the way
// a user sees it (a selectable vs. grayed-out <option>). This is the contract
// Hermes broke: it treated the `--agent` flag (which registers the agent
// *script* — a .js path) as its CLI command, so the command was never found and
// Hermes was always grayed out even when installed.
//
// The scenario is set up programmatically (each provider resolves its command
// from its own LIQUIDOS_<P>_COMMAND override; the launcher passes the process
// env through to the server), but every assertion is the picker's rendered
// state, not an internal call:
//
//   * Installed — override points at a real executable (node itself) → the
//     provider is offered AND selectable.
//   * Uninstalled — Hermes' override points nowhere and its fallback locations
//     are neutralized (no ~/.local/bin, no PATH hit) → it is offered but grayed
//     out. A build that read `--agent` as the command would leave it selectable
//     here (the script path exists), so this is what makes the check discriminate.
//
// An in-process control agent (Stub A, always installed) rides along in every
// scenario, so a build that grayed out *everything* fails too.
//
// FLAG: like probe-agent-uninstalled-grayed.mjs, a <select>'s option text isn't
// reliably in visibleText() across engines, and "grayed out" is exactly the
// browser's native rendering of a disabled <option>. So state is read from the
// option's actual disabled flag — precisely what a person perceives.
//
// Run it:  node run-probe.mjs probe-provider-command-resolution.mjs
//

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootSandbox } from './sandbox.mjs';

export const fixture = null; // self-managed: each scenario boots with its own env

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE = new URL('./probe-provider-command-resolution.liquidos', import.meta.url);
const CONTROL = 'agent/test/agent-switch-stub-a-agent.js'; // in-process, always installed
const CONTROL_LABEL = 'Stub A';

const PROVIDERS = [
    { label: 'Hermes',      module: 'agent/hermes.js', env: 'LIQUIDOS_HERMES_COMMAND' },
    { label: 'Claude Code', module: 'agent/claude.js', env: 'LIQUIDOS_CLAUDE_COMMAND' },
    { label: 'Pi',          module: 'agent/pi.js',     env: 'LIQUIDOS_PI_COMMAND' }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Read a picker option's rendered state by its visible label: present? grayed?
const optionState = (page, label) => page.evaluate(text => {
    const select = document.getElementById('agent-select');
    if (!select) return null;
    const option = [...select.options].find(o => o.textContent.trim() === text);
    return option ? { present: true, disabled: option.disabled } : { present: false };
}, label);

// Open the app, reveal the debug-only picker, let it load /agents/probe, and
// return the named provider's option state alongside the control's.
const pickerStates = async (browser, url, providerLabel) => {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });
        await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
        await page.evaluate(() => window.liquidos.setDebugOpen(true));
        await page.waitForSelector('#agent-select', { timeout: 20000 });
        await sleep(1500); // loadAgentChoices rebuilds the <option>s from /agents/probe
        return {
            provider: await optionState(page, providerLabel),
            control: await optionState(page, CONTROL_LABEL)
        };
    } finally {
        await page.close().catch(() => {});
    }
};

// Boot the app with env overrides in force (the launcher inherits this process's
// env through to the server), run `fn(url)`, then tear down and restore env.
const withSandbox = async (overrides, agent, fn) => {
    const saved = {};
    for (const key of Object.keys(overrides)) {
        saved[key] = process.env[key];
        if (overrides[key] === undefined) delete process.env[key];
        else process.env[key] = overrides[key];
    }
    let sandbox;
    try {
        sandbox = await bootSandbox(FIXTURE, { agent, app: REPO_ROOT });
        await fn(sandbox.url);
    } finally {
        if (sandbox) sandbox.teardown();
        for (const key of Object.keys(saved)) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        await sleep(1200); // let the launcher's SIGTERM→SIGKILL + temp cleanup run
    }
};

const assertControlSelectable = (control, scenario) => {
    if (!control || !control.present || control.disabled) {
        throw new Error(`${scenario}: control "${CONTROL_LABEL}" should be present and selectable`);
    }
};

export default async ({ browser }) => {
    // Installed: each provider's override points at a real executable, so the
    // real app must offer it as a selectable choice.
    for (const provider of PROVIDERS) {
        await withSandbox(
            { [provider.env]: process.execPath },
            [provider.module, CONTROL],
            async url => {
                const { provider: option, control } = await pickerStates(browser, url, provider.label);
                if (!option || !option.present) {
                    throw new Error(`${provider.label}: not offered in the picker`);
                }
                if (option.disabled) {
                    throw new Error(`${provider.label}: grayed out even though ${provider.env} points at an existing executable`);
                }
                assertControlSelectable(control, `${provider.label} installed`);
            }
        );
    }

    // Uninstalled → grayed, through the same chain. Hermes had the bug (it read
    // the --agent script path as its command, which always exists, so it was
    // never grayed). Point its override nowhere and neutralize the fallbacks
    // (temp HOME so there's no ~/.local/bin/hermes, a PATH without it — but
    // keeping node's dir so the launcher can still spawn the server). A correct
    // build grays Hermes out; a build that reads --agent leaves it selectable.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'liquidos-nohome-'));
    const nodeDir = path.dirname(process.execPath);
    try {
        await withSandbox(
            {
                LIQUIDOS_HERMES_COMMAND: path.join(tmpHome, 'no-such-hermes'),
                HOME: tmpHome,
                PATH: `${nodeDir}:/usr/bin:/bin`
            },
            ['agent/hermes.js', CONTROL],
            async url => {
                const { provider: option, control } = await pickerStates(browser, url, 'Hermes');
                if (!option || !option.present) {
                    throw new Error('Hermes: not offered in the picker when uninstalled — it should still be listed');
                }
                if (!option.disabled) {
                    throw new Error('Hermes: selectable when its CLI is unreachable — an uninstalled agent must appear grayed out');
                }
                assertControlSelectable(control, 'Hermes uninstalled');
            }
        );
    } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
    }
};
