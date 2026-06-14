//
// probe-canvas-recover-hidden-on-clear.mjs
//
// Companion to probe-canvas-generate-gates. The fixture has a
// populated feature-requirements.txt and zero components. When the
// user opens the modal and deletes all the text, the textarea ends up
// empty — but there are still no components to write about, so the
// Generate/Repair callback must stay hidden. The gate fires on
// "textarea empty AND zero components", independent of whether the
// file's loaded outcome was 'empty' or 'present'.
//
// Run it:  node run-probe.mjs probe-canvas-recover-hidden-on-clear.mjs
//

export const fixture = 'canvas-with-reqs-no-components.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const onScreen  = (text, timeout = 5000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });
    const offScreen = (text, timeout = 5000) => page.waitForFunction(
        t => !document.body.innerText.includes(t), text, { timeout });

    await page.locator('#canvas-info').click();

    // Modal is open when its title is visible.
    await onScreen('Canvas Requirements').catch(() => {
        throw new Error('"Canvas Requirements" title did not appear — modal did not open');
    });

    // File loaded with content — neither Repair nor Generate should surface
    // (non-empty file → recover callback stays hidden). This also confirms
    // the async file fetch has settled before we clear.
    await offScreen('Repair').catch(() => {
        throw new Error('"Repair" appeared before the textarea was cleared — file may not have loaded');
    });
    await offScreen('Generate').catch(() => {
        throw new Error('"Generate" appeared before the textarea was cleared — file may not have loaded');
    });

    // Clear the textarea.
    await page.locator('#canvas-requirements-textarea').fill('');

    // Recover callback must stay hidden — zero components, nothing to write.
    // Neither "Generate" nor "Repair" should appear on screen.
    await sleep(300);
    const recoverVisible = await page.evaluate(
        () => document.body.innerText.includes('Generate') || document.body.innerText.includes('Repair')
    );
    if (recoverVisible) {
        throw new Error('recover callback (Generate or Repair) became visible after the user cleared the textarea on a zero-component canvas');
    }
};
