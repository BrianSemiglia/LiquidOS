//
// probe-component-build-cancel
//
// User opens the component's Requirements modal and clicks Cancel.
// The modal closes. That's the whole assertion — whether the edit
// is discarded and whether the agent is left alone are checked elsewhere
// (probe-component-build covers the dispatch path).
//
// Run it:  node run-probe.mjs probe-component-build-cancel
//

export const fixture = './workspace.liquidos';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const openRequirements = page.getByRole('button', { name: 'Edit Notes requirements' });
    const closeRequirements = page.getByRole('button', { name: 'Close' });

    // The component has mounted once its Requirements button is on screen.
    await openRequirements.waitFor({ state: 'visible', timeout: 20000 });

    // Open the requirements editor: its Close button appears.
    await openRequirements.dispatchEvent('click');
    await closeRequirements.waitFor({ state: 'visible', timeout: 5000 });

    // Close it: the editor's controls leave the screen.
    await closeRequirements.dispatchEvent('click');
    await closeRequirements.waitFor({ state: 'hidden', timeout: 5000 });
};
