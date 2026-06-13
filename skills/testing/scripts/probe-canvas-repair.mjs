//
// probe-canvas-repair.mjs
//
// User opens the canvas requirements modal on an empty canvas, clicks
// Repair → agent dispatched → test agent writes feature-requirements.txt.
// User closes the modal and reopens it; openCanvasRequirements re-fetches
// via /workspace/.../feature-requirements.txt every open, so the
// textarea now contains the agent's content. Probe asserts on that.
//
// Run it:  node run-probe.mjs probe-canvas-repair.mjs
//

export const fixture = 'canvas-build.liquidos';
export const agent = 'canvas-repair-test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    // Open the canvas requirements modal. Textarea empty; Repair surfaces.
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForSelector('#canvas-requirements-textarea', { state: 'visible', timeout: 5000 });
    await page.waitForFunction(
        () => {
            const cb = document.getElementById('canvas-requirements-recover-callback');
            return cb && !cb.hidden;
        },
        { timeout: 5000 }
    );
    // Click Repair.
    await page.locator('#canvas-requirements-recover-callback button').dispatchEvent('click');
    await sleep(500);

    // Close and reopen; openCanvasRequirements always re-fetches.
    await page.locator('#canvas-requirements-cancel').dispatchEvent('click');
    await sleep(300);
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const ta = document.getElementById('canvas-requirements-textarea');
            return ta && ta.value && ta.value.includes('REPAIRED_CANVAS_BY_TEST_AGENT');
        },
        { timeout: 5000 }
    );

    const textareaValue = await page.locator('#canvas-requirements-textarea').inputValue();
    console.log('textarea after Repair:', textareaValue.trim());
};
