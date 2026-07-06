//
// probe-suggestions-script-dedupes
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
// Run it:  node run-probe.mjs probe-suggestions-script-dedupes
//

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const fixture = './workspace.liquidos';

const SCRIPT = fileURLToPath(new URL('../../../suggestions/scripts/add-suggestions.mjs', import.meta.url));
const HOME_FIRST = 'ALPHA make the header bigger';
const BRAVO = 'BRAVO add a dark mode toggle';
const CHARLIE = 'CHARLIE show the current time';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Find the prompt bar by what it is to the user, not by id/class.
const promptBar = (page) => page.getByRole('textbox', { name: 'Prompt' });

// What a user gets by accepting the offered suggestion: clear so the ghost is
// offered, Tab to take it into the field, read the visible text, clear again.
// Clearing leaves the step index untouched, so arrow-stepping still works after.
const acceptTop = async (bar) => {
    await bar.fill('');
    await bar.press('Tab');
    const value = (await bar.inputValue()).trim();
    await bar.fill('');
    return value;
};

const expectTop = async (bar, want, label) => {
    const deadline = Date.now() + 8000;
    let seen = '';
    do {
        seen = await acceptTop(bar);
        if (seen === want) return;
        await sleep(150);
    } while (Date.now() < deadline);
    throw new Error(`${label} (offered ${JSON.stringify(seen)})`);
};

export default async ({ url, page, workspace }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    // Open the bar on the active canvas; confirm its existing ghost.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const bar = promptBar(page);
    await bar.waitFor({ timeout: 20000 });
    await bar.focus();
    await expectTop(bar, HOME_FIRST, 'home suggestions never loaded; can not test the live dedupe');

    // Re-add the existing LAST item on home, in place, while the page stays open.
    const run = spawnSync('node', [SCRIPT, 'home', CHARLIE], { cwd: workspace, encoding: 'utf8' });
    if (run.status !== 0) {
        throw new Error('add-suggestions script failed: ' + (run.stderr || run.stdout || `exit ${run.status}`));
    }

    // Live: the re-added existing item jumps to the front — no reload.
    await expectTop(bar, CHARLIE, 're-adding an existing idea did not move it to the front live (no reload)');

    // ArrowUp from the front wraps to the last item: BRAVO if deduped, a
    // trailing CHARLIE if it had been duplicated.
    await bar.press('ArrowUp');
    if (await acceptTop(bar) !== BRAVO) {
        throw new Error('re-adding an existing idea duplicated it (the list still ends with the re-added item)');
    }
};
