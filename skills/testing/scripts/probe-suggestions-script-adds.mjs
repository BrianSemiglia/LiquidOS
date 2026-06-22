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

export default async ({ url, page, workspace }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    // Open the bar on the active canvas and confirm its existing ghost — so the
    // change below is proven live, not a load race.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#global-text', { timeout: 20000 });
    await page.waitForFunction(
        first => document.getElementById('global-text').placeholder === first,
        HOME_FIRST,
        { timeout: 8000 }
    ).catch(() => { throw new Error('home suggestions never loaded; can not test the live update'); });

    // Call it the way the agent does: canvas name + idea(s), CWD = workspace.
    // This rewrites home/suggestions.json in place while the page stays open.
    const run = spawnSync('node', [SCRIPT, 'home', NEW_IDEA], { cwd: workspace, encoding: 'utf8' });
    if (run.status !== 0) {
        throw new Error('add-suggestions script failed: ' + (run.stderr || run.stdout || `exit ${run.status}`));
    }

    // No reload, no switch: the bar observes the file and the newest idea ghosts
    // in on its own.
    await page.waitForFunction(
        idea => document.getElementById('global-text').placeholder === idea,
        NEW_IDEA,
        { timeout: 8000 }
    ).catch(() => { throw new Error('the prompt bar did not pick up the in-place suggestions update live (no reload)'); });
};
