//
// probe-suggestions-script-adds.mjs
//
// The agent records suggestions only by calling the add-suggestions script with
// the CANVAS name (not a file path) plus its ideas — the script owns the file.
// This proves the live path: with the bar already open on the active canvas,
// running the script (which rewrites <canvas>/suggestions.json in place) makes
// the new idea appear as the ghost WITHOUT a reload or a canvas switch — and
// newest-first, ahead of what was already there.
//
// Run it:  node run-probe.mjs probe-suggestions-script-adds.mjs
//

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const fixture = './probe-suggestions-script-adds.liquidos';

const SCRIPT = fileURLToPath(new URL('../../suggestions/scripts/add-suggestions.mjs', import.meta.url));
const HOME_FIRST = 'ALPHA make the header bigger';
const NEW_IDEA = 'ZULU pin the freshest idea on top';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Find the prompt bar by what it is to the user, not by id/class.
const promptBar = (page) => page.getByRole('textbox', { name: 'Prompt' });

// What a user gets by accepting the top suggestion: clear so the ghost is
// offered, Tab to take it into the field, read the visible text, clear again.
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

    // Open the bar on the active canvas and confirm its existing ghost — so the
    // change below is proven live, not a load race.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const bar = promptBar(page);
    await bar.waitFor({ timeout: 20000 });
    await bar.focus();
    await expectTop(bar, HOME_FIRST, 'home suggestions never loaded; can not test the live update');

    // Call it the way the agent does: canvas name + idea(s), CWD = workspace.
    // This rewrites home/suggestions.json in place while the page stays open.
    const run = spawnSync('node', [SCRIPT, 'home', NEW_IDEA], { cwd: workspace, encoding: 'utf8' });
    if (run.status !== 0) {
        throw new Error('add-suggestions script failed: ' + (run.stderr || run.stdout || `exit ${run.status}`));
    }

    // No reload, no switch: the bar observes the file and the newest idea ghosts
    // in on its own — Tab now brings it in as the top suggestion.
    await expectTop(bar, NEW_IDEA, 'the prompt bar did not pick up the in-place suggestions update live (no reload)');
};
