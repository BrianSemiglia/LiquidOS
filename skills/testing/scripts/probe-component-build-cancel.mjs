//
// probe-component-build-cancel.mjs
//
// User opens the component's Requirements modal and clicks Cancel.
// The modal closes. That's the whole assertion — whether the edit
// is discarded and whether the agent is left alone are checked elsewhere
// (probe-component-build covers the dispatch path).
//
// Run it:  node run-probe.mjs probe-component-build-cancel.mjs
//

export const fixture = 'component-repair.liquidos';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-probe]', { timeout: 20000 });

    // Open the modal — the overlay appears in the DOM.
    await page.locator('[data-component-flip]').first().dispatchEvent('click');
    await page.waitForSelector('.requirements-overlay', { timeout: 5000 });

    // Click Cancel — the overlay must go away.
    await page.locator('[data-feature-cancel]').dispatchEvent('click');
    await page.waitForFunction(
        () => !document.querySelector('.requirements-overlay'),
        { timeout: 5000 }
    );
};
