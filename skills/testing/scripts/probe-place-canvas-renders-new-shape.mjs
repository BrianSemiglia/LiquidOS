//
// probe-place-canvas-renders-new-shape.mjs
//
// An old-shape canvas (the kind that defines place(items, components)
// and paints its own decoration around items, like foo7's woof
// canvas) must still render new-shape components (component.html
// entry). The probe boots a custom-place canvas whose only entry is a
// new-shape component carrying [data-place-marker]. The canvas paints
// its overlay, the harness paints the component, the marker shows.
//
// Run it:  node run-probe.mjs probe-place-canvas-renders-new-shape.mjs
//

export const fixture = 'place-canvas-new-shape.liquidos';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Canvas's own decoration paints first.
    await page.waitForSelector('[data-canvas-overlay]', { timeout: 10000 });
    // The new-shape component's marker must show too.
    await page.waitForSelector('[data-place-marker]', { timeout: 10000 });
};
