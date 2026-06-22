//
// probe-canvas-requirements-live-refresh.mjs
//
// User opens the canvas requirements modal on an empty canvas, clicks
// Generate. The agent writes feature-requirements.txt. The textarea
// must pick up the agent's write WITHOUT the user closing and
// reopening the modal — otherwise the user sees the loading state
// stop, the textarea sit empty, and has no idea the agent finished.
//
// Run it:  node run-probe.mjs probe-canvas-requirements-live-refresh.mjs
//

export const fixture = './probe-canvas-requirements-live-refresh.liquidos';
export const agent = 'agent/test/canvas-requirements-live-refresh-agent.js';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the canvas info button, then open the requirements modal.
    await page.locator('#canvas-reqs-toggle').click();
    await page.waitForSelector('#canvas-requirements-overlay:not([hidden])', { timeout: 5000 });
    // The fixture's canvas has no feature-requirements.txt → Generate
    // surfaces. Wait for it then click.
    await page.waitForSelector('#canvas-requirements-recover-callback:not([hidden]) button', { timeout: 5000 });
    await page.locator('#canvas-requirements-recover-callback button').click();

    // The agent runs and writes the file. The textarea must populate
    // in place — no reopen.
    await page.waitForFunction(
        () => document.getElementById('canvas-requirements-textarea')?.value?.includes('REPAIRED_CANVAS_BY_TEST_AGENT'),
        { timeout: 10000 }
    );
};
