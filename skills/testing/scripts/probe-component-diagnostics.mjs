//
// probe-component-diagnostics.mjs
//
// Feature: when a component's script fails to load (syntax error,
// missing export, etc.), the user sees the component is broken — the
// Repair button surfaces, the same way a thrown error would surface it.
// The harness doesn't need a separate "mount-error" presentation; load
// failure and runtime throw are the same broken-component story from
// the user's perspective.
//
// Asserts only what a person sees on screen (the word "Repair" coming
// and going), never the harness's internal elements or attributes.
//
// Run it:  node run-probe.mjs probe-component-diagnostics.mjs
//

export const fixture = './probe-component-diagnostics.liquidos';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const onScreen = (text, timeout = 10000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });

    // Wait for the component's own visible content to confirm it mounted.
    await onScreen('component with a deliberately broken functions.js', 20000);

    // Repair button surfaces — the affordance the user sees for any broken
    // component. The script has a syntax error, so the harness records the
    // load failure and surfaces "Repair" exactly as it does for a runtime throw.
    await onScreen('Repair').catch(() => {
        throw new Error('"Repair" never appeared on screen after the broken functions.js load failure');
    });
};
