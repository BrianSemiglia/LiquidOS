//
// probe-agent-switch.mjs
//
// The active agent lives in ui-state.json's `agent` key — switching it is a
// plain workspace write through the agent dropdown, with no dedicated endpoint.
// This proves, through the UI, that switching the dropdown actually swaps the
// runtime that dispatches: boot on Stub A, send a prompt, see A's marker; pick
// Stub B in the dropdown, send a prompt, see A's marker replaced by B's.
//
// Two stub agents back this (agent/test/agent-switch-stub-{a,b}-agent.js): each
// writes its own component with a unique on-screen marker when it runs.
//
// Switching is eventually-consistent: the dropdown writes ui-state.json and the
// harness applies it (watcher → runtime swap) and broadcasts agent-mode, which
// rebuilds the dropdown from server truth. A real user switches, then types once
// that has landed; the probe waits for the same thing before dispatching, rather
// than racing the swap.
//
// Run it:  node run-probe.mjs probe-agent-switch.mjs
//

export const fixture = 'canvas-build.liquidos';
export const agent = 'stub-a';

import { STUB_A_REPLY } from '../../../agent/test/agent-switch-stub-a-agent.js';
import { STUB_B_REPLY } from '../../../agent/test/agent-switch-stub-b-agent.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    const onScreen = (text, timeout = 10000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });
    const offScreen = (text, timeout = 10000) => page.waitForFunction(
        t => !document.body.innerText.includes(t), text, { timeout });
    const selectedAgentLabel = () => page.evaluate(() => {
        const sel = document.getElementById('agent-select');
        return sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.trim() : '';
    });
    // Wait until the dropdown has caught up to the server's active agent — i.e.
    // the agent-mode broadcast has landed and loadAgentChoices rebuilt the
    // <option>s from /agents/probe. That's the UI-visible "the switch applied"
    // signal; selectOption alone only sets the value optimistically.
    const waitForActiveAgent = async (label, timeout = 10000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (await selectedAgentLabel() === label
                && await page.evaluate(async () => {
                    try { const r = await fetch('/agents/probe', { cache: 'no-store' }); return r.ok ? (await r.json()).agentKind : null; }
                    catch { return null; }
                }) === label.toLowerCase().replace(' ', '-')) return;
            await sleep(150);
        }
        throw new Error('agent never settled on "' + label + '"');
    };
    const dispatch = async (text) => {
        await page.locator('#global-text').fill(text);
        await page.evaluate(() => document.getElementById('global-prompt').requestSubmit());
    };

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#global-text', { timeout: 20000 });
    // The agent picker is a debug-only control — it's hidden in the normal
    // view and rides with the debug rail. Switching agents through it is
    // therefore something a user does with the debug view open, so open it
    // (the same toggle the Mac app's View menu drives) before reaching for
    // the dropdown.
    await page.waitForFunction(() => typeof window.liquidos?.toggleDebug === 'function', { timeout: 10000 });
    await page.evaluate(() => window.liquidos.setDebugOpen(true));
    await page.waitForSelector('#agent-select', { timeout: 20000 });
    await sleep(1500);

    // Boot is on Stub A and nothing has dispatched yet.
    if (await page.locator('[data-agent-switch-marker]').count() !== 0) {
        throw new Error('an agent marker existed before any dispatch');
    }
    if (await selectedAgentLabel() !== 'Stub A') {
        throw new Error('dropdown did not start on "Stub A", got "' + (await selectedAgentLabel()) + '"');
    }

    // Stub A dispatches → A's marker shows up.
    await dispatch('go, agent A');
    await onScreen(STUB_A_REPLY).catch(() => { throw new Error('Stub A never produced ' + STUB_A_REPLY + ' on dispatch'); });

    // Pick Stub B and wait for the switch to actually land server-side.
    await page.selectOption('#agent-select', 'stub-b');
    await waitForActiveAgent('Stub B');

    // Stub B dispatches → B's marker replaces A's.
    await dispatch('go, agent B');
    await onScreen(STUB_B_REPLY).catch(() => { throw new Error('Stub B never produced ' + STUB_B_REPLY + ' after the switch'); });
    await offScreen(STUB_A_REPLY).catch(() => { throw new Error('Stub A marker still on screen after switching to Stub B'); });
    console.log('switched A → B through the dropdown; dispatched output followed the active agent');
};
