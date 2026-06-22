//
// probe-prompt-cancel.mjs
//
// User submits a prompt → the agent starts the work (the probe-built
// component appears: "BUILT") but keeps running → user clicks Stop →
// the server kills the agent and re-prompts on the same scope to undo
// the canceled task → the agent takes the work back off the canvas.
//
// The on-screen assertion: "BUILT" appears when the work starts and is gone
// after Stop. The agent only undoes when it's re-prompted to undo (a non-undo
// prompt would put the work back), so "BUILT" leaving is what proves the cancel
// stopped the job and re-prompted it to undo.
//
// The timeline assertion: a cancel is the user's choice, not a crash, so the
// canceled turn must land in the git log as "User did cancel" — never as
// "LiquidOS did crash".
//
// Run it:  node run-probe.mjs probe-prompt-cancel.mjs
//

import { spawnSync } from 'node:child_process';

export const fixture = './probe-prompt-cancel.liquidos';
export const agent = 'prompt-cancel-test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const gitLog = (workspace) =>
    spawnSync('git', ['-C', workspace, 'log', '--format=%B'], { encoding: 'utf8' }).stdout || '';

const waitFor = async (predicate, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(200);
    }
    return false;
};

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#global-text', { timeout: 20000 });
    await sleep(1500);

    if (await page.getByText('BUILT', { exact: true }).count() !== 0) {
        throw new Error('"BUILT" was on screen before the prompt submit');
    }

    // Submit a prompt — the agent starts the work and keeps running.
    await page.locator('#global-text').fill('Build the thing.');
    await page.evaluate(() => document.getElementById('global-prompt').requestSubmit());

    // The started work surfaces on screen.
    await page.getByText('BUILT', { exact: true }).waitFor({ timeout: 10000 });

    // The Stop button appears while the job runs; clicking it cancels the job
    // and re-prompts the agent to undo. (Playwright only clicks it once it's
    // actually visible, so this also asserts the button shows.)
    await page.getByRole('button', { name: 'Stop' }).click({ timeout: 5000 });

    // The undo runs: the started work is taken back off the canvas, so "BUILT"
    // leaves the screen.
    await page.getByText('BUILT', { exact: true }).waitFor({ state: 'detached', timeout: 10000 });

    // The canceled turn is recorded in the timeline as a cancel, not a crash.
    if (!await waitFor(() => /User did cancel/.test(gitLog(workspace)))) {
        throw new Error('the canceled turn was not committed as "User did cancel". Git log:\n' + gitLog(workspace));
    }
    if (/LiquidOS did crash/.test(gitLog(workspace))) {
        throw new Error('the canceled turn was committed as a crash. Git log:\n' + gitLog(workspace));
    }
};
