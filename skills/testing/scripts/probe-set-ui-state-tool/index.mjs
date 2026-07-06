//
// probe-set-ui-state-tool
//
// The agent's tool — skills/workspace/scripts/set-ui-state.sh — drives the
// system-panel state for the user. Run the tool the way the agent would and
// prove, through the rendered UI, that the panels follow: the prompt bar's "↑"
// Send and the Spaces picker's "Create" card coming and going. Asserts visible
// strings only — never the file the tool writes.
//
// Run it:  node run-probe.mjs probe-set-ui-state-tool
//

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixture = './workspace.liquidos';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(here, '../../../workspace/scripts/set-ui-state.sh');

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    const onScreen = (text, timeout = 6000) => page.waitForFunction(
        t => visibleText().includes(t), text, { timeout });
    const offScreen = (text, timeout = 6000) => page.waitForFunction(
        t => !visibleText().includes(t), text, { timeout });

    const tool = (...args) => {
        const out = execFileSync('bash', [TOOL, workspace, ...args], { encoding: 'utf8' });
        console.log('tool', args.join(' '), '->', out.trim());
    };

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 20000 });

    // Engaged to start: prompt bar up, picker closed.
    await onScreen('↑').catch(() => { throw new Error('prompt bar ("↑" Send) not visible on load'); });
    await offScreen('Create').catch(() => { throw new Error('canvas picker should be closed on load'); });

    // Tool hides the prompt bar (clean canvas).
    tool('--disengaged', 'prompt');
    await offScreen('↑').catch(() => { throw new Error('--disengaged prompt did not hide the prompt bar ("↑" still visible)'); });

    // Tool opens the Spaces picker.
    tool('--disengaged', 'canvasPicker');
    await onScreen('Create').catch(() => { throw new Error('--disengaged canvasPicker did not open the Spaces grid ("Create" never appeared)'); });

    // Tool returns to engaged — picker closes, prompt bar comes back.
    tool('--engaged');
    await offScreen('Create').catch(() => { throw new Error('--engaged did not close the picker ("Create" still visible)'); });
    await onScreen('↑').catch(() => { throw new Error('--engaged did not bring the prompt bar back ("↑" missing)'); });
};
