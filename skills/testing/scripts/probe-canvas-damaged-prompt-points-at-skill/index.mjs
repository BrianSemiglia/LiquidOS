//
// probe-canvas-damaged-prompt-points-at-skill
//
// The Repair card surfaced for a "Canvas is damaged" condition must hand
// the agent enough context to act without guessing. Skill discovery is
// LLM-decided and unreliable — the dispatched prompt is the only signal we
// control, so it must both name the original error AND point at the canvas
// skill.
//
// Proven through the UI: click Repair, and a stub agent paints the verbatim
// prompt it received back onto the (now healed) canvas. The probe asserts
// the on-screen readout carries both halves of the contract — never reading
// the callback's attribute or any dispatch internal.
//
// Run it:  node run-probe.mjs probe-canvas-damaged-prompt-points-at-skill
//

export const fixture = './workspace.liquidos';
export const agent = './agent.js';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // The damaged canvas surfaces its Repair card. Scope to that card by its
    // accessible name so we click its button, not some other Repair affordance.
    const repair = page.getByRole('group', { name: 'Canvas is damaged' })
        .getByRole('button', { name: 'Repair' });
    await repair.waitFor({ state: 'visible', timeout: 10000 });
    await repair.click();

    // Clicking Repair dispatches the prompt to the agent, which paints it back
    // onto the canvas. The dispatched prompt must carry the whole contract:
    // it names the original error AND points the agent at the canvas skill.
    await page.waitForFunction(
        () => {
            const text = visibleText();
            return text.includes('Repair required due to error')
                && /skills\/canvas\/SKILL\.md/i.test(text);
        },
        undefined,
        { timeout: 10000 }
    );
};
