//
// probe-agent-persists-restart
//
// Requirement: the selected agent survives reopening the workspace. A user who
// switches the agent dropdown, then quits and reopens the app, must land back
// on the agent they chose — not reset to the default.
//
// probe-agent-switch proves the WRITE half: switching the dropdown persists to
// ui-state.json and the running server swaps the runtime live. This proves the
// BOOT-RESTORE half that a page reload can't reach: a page reload re-fetches
// from the same still-running server, so it never exercises server startup.
// The bug lives in startup — the boot path must seed the active agent from
// ui-state.json's `agent` key, the same way it already seeds the active canvas.
//
// So this restarts the server for real. It's self-managed (fixture = null): it
// boots its own sandbox, switches to Stub B through the UI, then boots a SECOND
// server from the first's workspace directory — the materialized copy that now
// carries the switched ui-state.json — which is exactly "reopen the app". The
// reopened server must boot on Stub B.
//
// Run it:  node run-probe.mjs probe-agent-persists-restart
//

import { bootSandbox } from '../sandbox.mjs';

export const fixture = null; // self-managed: two sequential boots, same workspace
const FIXTURE = new URL('./workspace.liquidos', import.meta.url);
const AGENTS = [
    new URL('./agent-a.js', import.meta.url), // first → default-active on a fresh boot
    new URL('./agent-b.js', import.meta.url),
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The selected agent as the UI shows it (dropdown label). Mirrors
// probe-agent-switch — the picker rides with the debug rail, so open it first.
const openPickerAt = async (browser, url) => {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });
    await page.waitForFunction(() => typeof window.liquidos?.setDebugOpen === 'function', { timeout: 10000 });
    await page.evaluate(() => window.liquidos.setDebugOpen(true));
    await page.waitForSelector('#agent-select', { timeout: 20000 });
    return page;
};
const selectedAgentLabel = (page) => page.evaluate(() => {
    const sel = document.getElementById('agent-select');
    return sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.trim() : '';
});
const serverActiveAgent = (page) => page.evaluate(async () => {
    try { const r = await fetch('/agents/probe', { cache: 'no-store' }); return r.ok ? (await r.json()).agentKind : null; }
    catch { return null; }
});
// Wait until both the dropdown and server truth have settled on `label`.
const waitForActiveAgent = async (page, label, timeout = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await selectedAgentLabel(page) === label && await serverActiveAgent(page) === label) return;
        await sleep(150);
    }
    throw new Error('agent never settled on "' + label + '"');
};

export default async ({ browser }) => {
    // --- first launch: default is Stub A; switch to Stub B through the UI ----
    const first = await bootSandbox(FIXTURE, { agent: AGENTS });
    let reopened;
    try {
        const page1 = await openPickerAt(browser, first.url);
        page1.on('pageerror', err => console.log('[page error]', err.message));
        if (await selectedAgentLabel(page1) !== 'Stub A') {
            throw new Error('fresh boot did not default to "Stub A", got "' + (await selectedAgentLabel(page1)) + '"');
        }
        await page1.selectOption('#agent-select', 'Stub B');
        await waitForActiveAgent(page1, 'Stub B');
        await page1.close();

        // --- reopen: a new server booted from the first's workspace ----------
        // bootSandbox copies the source dir now, while `first` is still up, so
        // the copy carries the switched ui-state.json. Then we drop `first`.
        reopened = await bootSandbox(first.workspace, { agent: AGENTS });
    } finally {
        first.teardown();
    }

    // --- the reopened workspace must boot on the persisted agent ------------
    try {
        const page2 = await openPickerAt(browser, reopened.url);
        page2.on('pageerror', err => console.log('[page error]', err.message));
        const label = await selectedAgentLabel(page2);
        if (label !== 'Stub B') {
            throw new Error('reopened workspace reset the agent to "' + label + '" instead of the persisted "Stub B"');
        }
        if (await serverActiveAgent(page2) !== 'Stub B') {
            throw new Error('dropdown showed "Stub B" but the reopened server booted a different agent');
        }
        await page2.close();
        console.log('switched to Stub B, restarted the server, and it reopened on Stub B');
    } finally {
        reopened.teardown();
    }
};
