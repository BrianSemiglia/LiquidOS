//
// probe-canvas-damaged-prompt-carries-contract.mjs
//
// The Repair card surfaced for a canvas-damaged condition must hand
// the agent enough context to act without guessing. Skill discovery is
// LLM-decided and unreliable — the prompt is the only signal we
// control. The probe asserts the canvas-Repair callback's prompt names
// the contract (index.json entries must end in component.html, the
// agent must write the file AND update index.json), so a dispatched
// agent has the recipe without needing to find any specific skill.
//
// Run it:  node run-probe.mjs probe-canvas-damaged-prompt-points-at-skill.mjs
//

export const fixture = './probe-canvas-damaged-prompt-points-at-skill.liquidos';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the canvas Repair card.
    await page.waitForSelector('[role="group"][data-repair-level="canvas"]', { timeout: 10000 });

    // Read the callback's prompt — that's what gets dispatched on click.
    const prompt = await page.evaluate(() => {
        const card = document.querySelector('[role="group"][data-repair-level="canvas"]');
        const cb = card?.querySelector('liquidos-callback');
        return cb?.getAttribute('prompt') || '';
    });

    const expectations = [
        { name: 'names the original error',     ok: /Repair required due to error/.test(prompt) },
        { name: 'points at the canvas skill',   ok: /skills\/canvas\/SKILL\.md/i.test(prompt) }
    ];
    const failed = expectations.filter(e => !e.ok);
    if (failed.length > 0) {
        console.error('prompt missing contract:', failed.map(f => f.name).join(', '));
        console.error('--- prompt as carried ---');
        console.error(prompt);
        console.error('---');
        throw new Error('prompt missing contract: ' + failed.map(f => f.name).join(', '));
    }
};
