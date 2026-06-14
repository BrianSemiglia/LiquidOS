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

    const onScreen  = (text, timeout = 10000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });
    const offScreen = (text, timeout = 10000) => page.waitForFunction(
        t => !document.body.innerText.includes(t), text, { timeout });

    // The user-facing affordance: a visible "Repair" label on first paint.
    await onScreen('Repair').catch(() => {
        throw new Error('"Repair" never appeared on screen for a missing-component canvas');
    });

    // Let any race flicker settle then assert no noise.
    await new Promise(r => setTimeout(r, 500));

    // No "missing:" diagnostic text sitting next to the Repair card.
    await offScreen('missing:').catch(() => {
        throw new Error('"missing:" diagnostic text is still visible next to the Repair card');
    });

    // The canvas's decorative overlay (textContent "rain-overlay") must be
    // torn down — leaving it beside the Repair card would be confusing noise.
    await offScreen('rain-overlay').catch(() => {
        throw new Error('"rain-overlay" canvas overlay is still on screen after canvas-level error');
    });
};
