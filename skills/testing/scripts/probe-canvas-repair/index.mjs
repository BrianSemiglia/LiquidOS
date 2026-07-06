//
// probe-canvas-repair
//
// User opens the canvas requirements modal on an empty canvas, clicks
// Repair → agent dispatched → test agent writes feature-requirements.txt.
// User closes the modal and reopens it; openCanvasRequirements re-fetches
// via /workspace/.../feature-requirements.txt every open, so the
// textarea now contains the agent's content and "Repair" is gone.
//
// Run it:  node run-probe.mjs probe-canvas-repair
//

export const fixture = './workspace.liquidos';
export const agent = './agent.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    const onScreen  = (text, timeout = 5000) => page.waitForFunction(
        t => visibleText().includes(t), text, { timeout });
    const offScreen = (text, timeout = 5000) => page.waitForFunction(
        t => !visibleText().includes(t), text, { timeout });

    // Open the canvas requirements modal.
    await page.getByRole('button', { name: 'Edit canvas requirements' }).dispatchEvent('click');
    await onScreen('Build').catch(() => {
        throw new Error('canvas requirements editor did not open');
    });

    // Textarea is empty; Repair surfaces.
    await onScreen('Repair').catch(() => {
        throw new Error('"Repair" did not appear in the empty canvas requirements modal');
    });

    // Click Repair.
    await page.locator('#canvas-requirements-recover-callback button').dispatchEvent('click');
    await sleep(500);

    // Close and reopen; openCanvasRequirements always re-fetches.
    await page.locator('#canvas-requirements-cancel').dispatchEvent('click');
    await sleep(300);
    await page.getByRole('button', { name: 'Edit canvas requirements' }).dispatchEvent('click');
    await onScreen('Build').catch(() => {
        throw new Error('canvas requirements editor did not reopen');
    });

    // After the agent wrote the file, the textarea is populated and
    // "Repair" clears — that is the visible confirmation that Repair worked.
    await offScreen('Repair', 5000).catch(() => {
        throw new Error('"Repair" is still on screen after re-opening — test agent may not have written the file');
    });

    // Log the textarea value for diagnostic purposes (not an assertion).
    const textareaValue = await page.locator('#canvas-requirements-textarea').inputValue();
    console.log('textarea after Repair:', textareaValue.trim());
};
