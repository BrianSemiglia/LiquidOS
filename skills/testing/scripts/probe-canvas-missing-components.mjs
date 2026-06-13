//
// probe-canvas-missing-components.mjs
//
// Canvas's input.json references a component that doesn't have a real
// entry file (the foo7-style case: entries are folder paths from the
// old shape, the new shape needs component.html). The canvas is broken
// from the user's perspective — the user should see the canvas-level
// Repair card (same one probe-canvas-damaged exercises for malformed
// input.json), not a silently empty canvas.
//
// Run it:  node run-probe.mjs probe-canvas-missing-components.mjs
//

export const fixture = 'component-missing.liquidos';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // The user-facing affordance: a visible Repair button on first paint.
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button'))
            .some(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0),
        { timeout: 10000 }
    );

    // And nothing else — no per-file "missing:" noise sitting next to
    // the Repair card, no leftover canvas decoration (e.g. a rain
    // overlay) that the canvas painted before the harness knew it was
    // broken. Either would be confusing noise around the Repair card.
    await new Promise(r => setTimeout(r, 500)); // let any race flicker in
    const noisy = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        return {
            missingHits:          (bodyText.match(/missing:/g) || []).length,
            stillHasLiquidosFile: !!document.querySelector('liquidos-file'),
            canvasOverlayHits:    document.querySelectorAll('[data-canvas-overlay]').length
        };
    });
    if (noisy.missingHits > 0) {
        throw new Error(noisy.missingHits + ' "missing:" text(s) still rendered next to Repair card');
    }
    if (noisy.stillHasLiquidosFile) {
        throw new Error('<liquidos-file> elements still in DOM after canvas-level error');
    }
    if (noisy.canvasOverlayHits > 0) {
        throw new Error(noisy.canvasOverlayHits + ' canvas-overlay element(s) still in DOM after canvas-level error');
    }
};
