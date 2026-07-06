//
// probe-component-build
//
// User opens a component's Requirements modal, edits the text, clicks
// Build. The agent is supposed to be dispatched to update the
// implementation to match. The stubbed agent for this probe re-writes
// the component's view to a known marker; the probe waits for the
// marker to appear in the live DOM. If Build never dispatched the
// agent, the marker never lands and the assertion times out.
//
// Run it:  node run-probe.mjs probe-component-build
//

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const fixture = './workspace.liquidos';
export const agent = './agent.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The workspace git timeline brackets every agent turn: a "will prompt" commit
// snapshots the pre-agent state, then a "did prompt" commit records the result.
const gitLog = workspace => execFileSync('git', ['log', '--format=%B'], { cwd: workspace, encoding: 'utf8' });

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    // Seed a known BEFORE_PROBE_MARKER in feature-requirements.txt so
    // the dispatched prompt's "Previous requirements:" section has a
    // string we can assert on. The textarea will load this value when
    // the modal opens.
    const featurePath = path.join(workspace, 'home', 'components', 'probe', 'feature-requirements.txt');
    fs.writeFileSync(featurePath, '- BEFORE_PROBE_MARKER initial text\n');

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-probe]', { timeout: 20000 });

    // Open the modal; wait for the textarea to actually carry the
    // seeded BEFORE text (loadRequirements fetches it async).
    await page.getByRole('button', { name: 'Edit Probe requirements' }).dispatchEvent('click');
    await page.waitForFunction(
        () => document.querySelector('[data-feature-requirements]')?.value?.includes('BEFORE_PROBE_MARKER'),
        { timeout: 5000 }
    );
    await page.locator('[data-feature-requirements]').fill('- AFTER_PROBE_MARKER edited requirement\n');
    await page.locator('[data-feature-save]').dispatchEvent('click');

    // The agent's "update" is to swap the component's view. On a
    // healthy Build dispatch with the right prompt, the success marker
    // appears. If the prompt was malformed (or absent), the agent
    // writes a failure view carrying the actual prompt — also visible
    // in the DOM — and the probe surfaces it instead of timing out.
    await page.waitForFunction(
        () => document.querySelector('[data-built-by-test]')
            || document.querySelector('[data-built-failure]'),
        { timeout: 10000 }
    );

    const failure = await page.evaluate(() => {
        const el = document.querySelector('[data-built-failure]');
        if (!el) return null;
        return {
            reason: el.querySelector('p')?.textContent || '(no reason)',
            promptReceived: el.querySelector('[data-prompt-received]')?.textContent || '(empty)'
        };
    });
    if (failure) {
        console.error('FAIL:', failure.reason);
        console.error('--- prompt the agent received ---');
        console.error(failure.promptReceived);
        console.error('---');
        throw new Error(failure.reason);
    }

    // The turn is bracketed in the workspace git timeline: a "will prompt"
    // commit snapshots the pre-agent state, then a "did prompt" commit records
    // the result. The "did" commit lands just after the agent job returns, a
    // beat behind the DOM marker — wait for it, then assert will-before-did
    // (git log is newest-first, so "did" sits above the older "will").
    let willAt = -1, didAt = -1;
    for (let i = 0; i < 100; i++) {
        const log = gitLog(workspace);
        willAt = log.indexOf('User will prompt');
        didAt = log.indexOf('User did prompt');
        if (willAt !== -1 && didAt !== -1) break;
        await sleep(100);
    }
    if (willAt === -1) throw new Error('no "will prompt" snapshot committed before the agent ran');
    if (didAt === -1) throw new Error('agent turn produced no "did prompt" commit');
    if (didAt > willAt) throw new Error('"will prompt" must be committed before "did prompt"');
    console.log('  ok  the agent turn is bracketed (will → did) in the workspace git timeline');
};
