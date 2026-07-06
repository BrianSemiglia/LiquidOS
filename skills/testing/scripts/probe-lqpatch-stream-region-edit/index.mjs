//
// probe-lqpatch-stream-region-edit
//
// The agent streams into a NAMED CANVAS REGION — not a component — and the
// result shows on screen and survives a reload (proving it persisted to the
// region's own file). Two distinct targets in one region file both update, and a
// component-scoped op still lands in component.html (the generalization didn't
// break components).
//
// Asserts only visible text — no internals, no disk reads.
//
// Run it:  node run-probe.mjs probe-lqpatch-stream-region-edit
//

export const fixture = './workspace.liquidos';
export const agent = './agent.js';

const onScreen = (page, text) => page.evaluate(t => visibleText().includes(t), text);

export default async ({ url, page }) => {
    const token = 'TOK_' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const regionA = 'REGIONA_' + token;   // atomic replace into a region target
    const regionB = 'REGIONB_' + token;   // streamed into a second target in the SAME region file
    const component = 'PERSISTED_' + token; // component-scoped op still hits component.html

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Region seed is on screen; the tokens are not.
    await page.waitForFunction(() => visibleText().includes('HERO_A0'), { timeout: 20000 });
    for (const s of [regionA, regionB, component]) {
        if (await onScreen(page, s)) throw new Error(`"${s}" was on screen before the prompt`);
    }

    const bar = page.getByRole('textbox', { name: 'Prompt' });
    await bar.waitFor({ timeout: 15000 });
    await bar.fill('REPLACE_WITH: ' + token);
    await bar.press('Enter');

    // All three land on screen.
    for (const s of [regionA, regionB, component]) {
        await page.waitForFunction(t => visibleText().includes(t), s, { timeout: 30000 }).catch(() => {});
        if (!(await onScreen(page, s))) throw new Error(`never saw "${s}" after the agent ran`);
    }

    // Survive a reload — proving each persisted to its file (region tokens to
    // regions/hero.html, component token to component.html), not just painted.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => visibleText().includes('HERO'), { timeout: 15000 }).catch(() => {});
    for (const s of [regionA, regionB, component]) {
        await page.waitForFunction(t => visibleText().includes(t), s, { timeout: 15000 }).catch(() => {});
        if (!(await onScreen(page, s))) throw new Error(`"${s}" disappeared on reload — not persisted`);
    }
};
