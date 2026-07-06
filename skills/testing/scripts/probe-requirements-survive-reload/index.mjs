//
// probe-requirements-survive-reload
//
// Requirement: when a user edits a component's requirements and saves, the
// text is persisted — not just held in the open editor. Reloading the app and
// reopening the editor must show the saved text.
//
// The build probes (probe-component-build, probe-canvas-build) prove that
// saving DISPATCHES the agent; none proves a user-TYPED edit survives a
// reload. This is the durability half of the save contract, asserted purely
// through the view: type into the editor, save, reload, reopen, read it back.
//
// Saving also enqueues an agent reconcile job, but that's not under test here,
// so this runs with agent = 'none'.
//
// Run it:  node run-probe.mjs probe-requirements-survive-reload
//

export const fixture = './workspace.liquidos';
export const agent = 'agent/none-agent.js';

const MARKER = '- REQ_PERSIST_RELOAD_MARKER must survive a reload';

const openEditor = async (page) => {
    await page.getByRole('button', { name: 'Edit Probe requirements' }).dispatchEvent('click');
    await page.waitForSelector('[data-feature-requirements]', { timeout: 8000 });
};

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-probe]', { timeout: 20000 });

    // --- type a requirement and save -------------------------------------
    await openEditor(page);
    await page.locator('[data-feature-requirements]').fill(MARKER + '\n');
    // Let the save finish writing before we reload — synchronize on the save
    // request landing (plumbing; the assertion below is what the user sees).
    const saved = page.waitForResponse(
        res => /\/features$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
        { timeout: 10000 }
    );
    await page.locator('[data-feature-save]').first().dispatchEvent('click');
    await saved;

    // --- reload, reopen, and read the edit back --------------------------
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-probe]', { timeout: 20000 });

    await openEditor(page);
    // The reopened editor populates async; wait for the typed text to return.
    await page.waitForFunction(
        (expected) => Array.from(document.querySelectorAll('[data-feature-requirements]'))
            .some(ta => (ta.value || '').includes(expected)),
        MARKER,
        { timeout: 10000 }
    );
};
