//
// probe-canvas-create.mjs
//
// User zooms out to the grid → clicks "+ New" → name modal opens directly →
// types a name + submits → the new canvas appears in the grid, is the one now
// selected, and is still there after a reload. UI-only; no agent involved.
// (Sharing is disabled, so Create goes straight to the name dialog rather than
// through the browse overlay.)
//
// Run it:  node run-probe.mjs probe-canvas-create.mjs
//

export const fixture = './probe-canvas-create.liquidos';

const NAME = 'probe-created-canvas';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const showGrid    = page.getByRole('button', { name: 'Show all spaces' });
    const newCard     = page.getByRole('button', { name: 'Create a new canvas' });
    const createdCard = page.getByRole('button', { name: 'Open ' + NAME + ' space' });

    // Open the grid. Pre-condition: it doesn't list the new canvas yet.
    await showGrid.waitFor({ timeout: 20000 });
    await showGrid.dispatchEvent('click');
    await newCard.waitFor({ timeout: 10000 });
    if (await createdCard.count() !== 0) {
        throw new Error('canvas already existed before create');
    }

    // + New → name modal opens directly → type + submit.
    await newCard.dispatchEvent('click');
    const dialog = page.getByRole('dialog', { name: 'New Canvas' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.getByPlaceholder('Name').fill(NAME);
    await page.getByPlaceholder('Name').press('Enter');

    // Created → the whole stack tears down and the user lands on the new canvas.
    await dialog.waitFor({ state: 'hidden', timeout: 10000 });

    // Re-open the grid: the new canvas is listed, and it's the one now selected.
    // Creating a canvas selects it — the user doesn't stay on the one they were on.
    await showGrid.dispatchEvent('click');
    await createdCard.waitFor({ timeout: 10000 });
    const current = await createdCard.getAttribute('aria-current');
    if (current !== 'page') {
        throw new Error('new canvas was not selected after create; aria-current=' + current);
    }

    // It's durable: after a reload the grid still lists it. A creation that was
    // only painted into this session's grid (never committed) would be gone.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await showGrid.waitFor({ timeout: 20000 });
    await showGrid.dispatchEvent('click');
    await createdCard.waitFor({ timeout: 10000 });
};
