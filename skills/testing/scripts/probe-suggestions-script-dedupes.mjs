//
// probe-suggestions-script-dedupes.mjs
//
// Re-adding an idea that's already in the list refreshes it to the front rather
// than duplicating it — proven live (bar open, file rewritten in place, no
// reload). home starts as [ALPHA, BRAVO, CHARLIE]. Re-adding the LAST item
// (CHARLIE) must leave [CHARLIE, ALPHA, BRAVO] — not
// [CHARLIE, ALPHA, BRAVO, CHARLIE].
//
// Two discriminating checks:
//   - CHARLIE ghosts in live at the front → the re-added existing item moved up,
//     so the script ran, reordered, and the bar observed it without a reload.
//   - From the front, ArrowUp wraps to the LAST item. Deduped that's BRAVO;
//     duplicated it would wrap to a trailing CHARLIE. Landing on BRAVO proves
//     CHARLIE appears once.
//
// Run it:  node run-probe.mjs probe-suggestions-script-dedupes.mjs
//

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const fixture = './probe-suggestions-script-dedupes.liquidos';

const SCRIPT = fileURLToPath(new URL('../../suggestions/scripts/add-suggestions.mjs', import.meta.url));
const HOME_FIRST = 'ALPHA make the header bigger';
const BRAVO = 'BRAVO add a dark mode toggle';
const CHARLIE = 'CHARLIE show the current time';

const ghostIs = (page, text, timeout = 6000) => page.waitForFunction(
    t => document.getElementById('global-text').placeholder === t, text, { timeout });

export default async ({ url, page, workspace }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    // Open the bar on the active canvas; confirm its existing ghost.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#global-text', { timeout: 20000 });
    await ghostIs(page, HOME_FIRST, 8000).catch(() => { throw new Error('home suggestions never loaded; can not test the live dedupe'); });

    // Re-add the existing LAST item on home, in place, while the page stays open.
    const run = spawnSync('node', [SCRIPT, 'home', CHARLIE], { cwd: workspace, encoding: 'utf8' });
    if (run.status !== 0) {
        throw new Error('add-suggestions script failed: ' + (run.stderr || run.stdout || `exit ${run.status}`));
    }

    // Live: the re-added existing item jumps to the front — no reload.
    await ghostIs(page, CHARLIE, 8000).catch(() => {
        throw new Error('re-adding an existing idea did not move it to the front live (no reload)');
    });

    // ArrowUp from the front wraps to the last item: BRAVO if deduped, a
    // trailing CHARLIE if it had been duplicated.
    await page.locator('#global-text').focus();
    await page.keyboard.press('ArrowUp');
    await ghostIs(page, BRAVO).catch(() => {
        throw new Error('re-adding an existing idea duplicated it (the list still ends with the re-added item)');
    });
};
