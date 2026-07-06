//
// probe-sandbox-land
//
// Locks down the "agent lands a verified sandbox batch into the source
// workspace" flow before that write path is refactored.
//
// User edits a component's requirements and clicks Build, dispatching the
// agent. The stubbed agent stages a new component.html in a throwaway
// sandbox, then POSTs a batch to the source server's write endpoint that
// mixes both supported shapes — copy-from-sandbox ({path, from}) and inline
// ({path, content}). The component re-renders to the landed marker. If the
// endpoint rejected or failed to apply the batch, the marker never appears.
//
// Run it:  node run-probe.mjs probe-sandbox-land
//

export const fixture = './workspace.liquidos';
export const agent = './agent.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    const onScreen = (text, timeout = 10000) => page.waitForFunction(
        t => visibleText().includes(t), text, { timeout });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-probe]', { timeout: 20000 });

    // Edit the component's requirements and Build — this dispatches the agent.
    await page.getByRole('button', { name: 'Edit Probe requirements' }).dispatchEvent('click');
    await page.waitForSelector('[data-feature-requirements]', { timeout: 5000 });
    await page.locator('[data-feature-requirements]').fill('- please land via sandbox batch\n');
    await page.locator('[data-feature-save]').dispatchEvent('click');

    // The agent lands its batch through the write endpoint; the component
    // re-renders to the marker. Visible only if the whole batch was accepted
    // and applied to the source workspace.
    await onScreen('LANDED_BY_SANDBOX_BATCH').catch(() => {
        throw new Error('landed marker never appeared — sandbox batch-write did not apply to the source workspace');
    });

    // Reload: the marker is still there, proving the batch landed on disk
    // (one coherent update), not just in the live DOM.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1000);
    await onScreen('LANDED_BY_SANDBOX_BATCH').catch(() => {
        throw new Error('landed marker gone after reload — batch did not persist to the source workspace');
    });
};
