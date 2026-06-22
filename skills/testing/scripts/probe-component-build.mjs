//
// probe-component-build.mjs
//
// User opens a component's Requirements modal, edits the text, clicks
// Build. The agent is supposed to be dispatched to update the
// implementation to match. The stubbed agent for this probe re-writes
// the component's view to a known marker; the probe waits for the
// marker to appear in the live DOM. If Build never dispatched the
// agent, the marker never lands and the assertion times out.
//
// Run it:  node run-probe.mjs probe-component-build.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './probe-component-build.liquidos';
export const agent = 'agent/test/component-build-test-agent.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
};
