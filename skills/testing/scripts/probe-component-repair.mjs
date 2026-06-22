//
// probe-component-repair.mjs
//
// User opens a flip-back whose feature-requirements.txt is present but
// empty, clicks the Generate button → agent dispatched → agent writes the
// requirements file. User closes the flip-back and reopens it; the
// harness re-fetches the file and the "Generate" recover affordance
// disappears because the file now has content. Probe asserts the
// visible change: "Generate" present before → absent after the agent's
// write (the recover overlay hides itself when the file is non-empty).
//
// Asserts only what a person sees on screen, never internal DOM
// attributes or structure.
//
// Run it:  node run-probe.mjs probe-component-repair.mjs
//

export const fixture = './probe-component-repair.liquidos';
export const agent = 'component-repair-test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const onScreen = (text, timeout = 8000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });
    const offScreen = (text, timeout = 8000) => page.waitForFunction(
        t => !document.body.innerText.includes(t), text, { timeout });

    // Wait for the component's own content to confirm it mounted.
    await onScreen('probe component with empty requirements', 20000);

    // Open the flip-back. Requirements file is present but empty so the recover
    // affordance reads "Generate" — the user can see it.
    await page.getByRole('button', { name: 'Edit Probe requirements' }).dispatchEvent('click');
    await onScreen("Generate").catch(() => {
        throw new Error('"Generate" did not appear when the flip-back opened (requirements file present but empty)');
    });
    console.log('  ok  flip opened: Generate visible');

    // Click Generate → agent dispatched and writes the requirements file.
    await page.locator('[data-feature-recover]').dispatchEvent('click');
    // Give the agent time to write the file.
    await sleep(500);

    // Close (returns to front via the Cancel button).
    await page.locator('[data-feature-cancel]').dispatchEvent('click');
    await sleep(300);

    // Reopen — harness re-fetches via /component/<path>/features so the
    // recover overlay now reflects the agent's write: file is non-empty,
    // so the recover button hides entirely. The user no longer sees "Generate".
    await page.getByRole('button', { name: 'Edit Probe requirements' }).dispatchEvent('click');
    await offScreen("Generate").catch(() => {
        throw new Error('"Generate" is still on screen after the agent wrote the requirements file — recover overlay did not clear');
    });
    console.log('  ok  after Generate click + reopen: "Generate" gone from screen');
};
