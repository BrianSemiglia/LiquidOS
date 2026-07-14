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

// The controls a user works with, found the way a user finds them: the Notes
// component's requirements button by its label, the field by the prompt it shows.
const requirementsButton = (page) => page.getByRole('button', { name: 'Edit Notes requirements' });
const requirementsField = (page) => page.getByPlaceholder(/Describe what this component should do/);

const openEditor = async (page) => {
    await requirementsButton(page).dispatchEvent('click');
    await requirementsField(page).waitFor({ state: 'visible', timeout: 8000 });
};

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // The component has mounted once its Requirements button is on screen.
    await requirementsButton(page).waitFor({ state: 'visible', timeout: 20000 });

    // --- type a requirement and save -------------------------------------
    await openEditor(page);
    await requirementsField(page).fill(MARKER + '\n');
    // Let the save finish writing before we reload — synchronize on the save
    // request landing (plumbing; the assertion below is what the user sees).
    const saved = page.waitForResponse(
        res => /\/features$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
        { timeout: 10000 }
    );
    await page.getByRole('button', { name: 'Build' }).dispatchEvent('click');
    await saved;

    // --- reload, reopen, and read the edit back --------------------------
    await page.reload({ waitUntil: 'domcontentloaded' });
    await requirementsButton(page).waitFor({ state: 'visible', timeout: 20000 });

    await openEditor(page);
    // The reopened editor populates async; wait for the typed text to return,
    // reading what the field actually shows on screen.
    let shown = '';
    for (let i = 0; i < 50 && !shown.includes(MARKER); i++) {
        shown = await requirementsField(page).inputValue();
        if (!shown.includes(MARKER)) await page.waitForTimeout(200);
    }
    if (!shown.includes(MARKER))
        throw new Error('reopened editor did not show the saved requirement; field read: ' + JSON.stringify(shown));
};
