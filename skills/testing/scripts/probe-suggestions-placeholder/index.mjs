//
// probe-suggestions-placeholder
//
// The empty prompt bar ghosts in the active canvas's suggestions. This drives
// the bar the way a user does and observes each suggestion through the visible
// text Tab leaves in the field:
//   - on load the first suggestion is offered
//   - ArrowDown / ArrowUp step through the list (only while focused)
//   - Tab accepts the current suggestion as typed text in the field
//   - clearing back to empty brings the ghost back so it can be stepped again
//
// The visible proof is the field's value after Tab — the text a user sees typed
// into the box — never the placeholder attribute or the element id.
//
// Run it:  node run-probe.mjs probe-suggestions-placeholder
//

export const fixture = './workspace.liquidos';

const ALPHA = 'ALPHA make the header bigger';
const BRAVO = 'BRAVO add a dark mode toggle';
const CHARLIE = 'CHARLIE show the current time';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Find the prompt bar by what it is to the user, not by id/class.
const promptBar = (page) => page.getByRole('textbox', { name: 'Prompt' });

// Accept whatever suggestion the empty bar is currently offering — Tab fills the
// field — read that visible text, then clear back to empty so the ghost (and
// arrow-stepping) keep working. Returns '' when nothing is offered yet.
const accepted = async (bar) => {
    await bar.press('Tab');
    const value = (await bar.inputValue()).trim();
    await bar.fill('');
    return value;
};

// Poll the accept gesture until the bar offers exactly `want` (suggestions load
// async). Stepping state (the current index) is untouched by accept.
const expectOffered = async (bar, want, label) => {
    const deadline = Date.now() + 8000;
    let seen = '';
    do {
        seen = await accepted(bar);
        if (seen === want) return;
        await sleep(150);
    } while (Date.now() < deadline);
    throw new Error(`${label}: expected the bar to offer ${JSON.stringify(want)}, got ${JSON.stringify(seen)}`);
};

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const bar = promptBar(page);
    await bar.waitFor({ timeout: 20000 });
    await bar.focus();

    // First suggestion is offered on load.
    await expectOffered(bar, ALPHA, 'load');

    // ArrowDown steps forward through the list; ArrowUp steps back. Each step is
    // proven by what Tab then brings in.
    await bar.press('ArrowDown');
    if (await accepted(bar) !== BRAVO) throw new Error('ArrowDown did not advance to the next suggestion');
    await bar.press('ArrowDown');
    if (await accepted(bar) !== CHARLIE) throw new Error('ArrowDown did not advance to the third suggestion');
    await bar.press('ArrowUp');
    if (await accepted(bar) !== BRAVO) throw new Error('ArrowUp did not step back to the previous suggestion');

    // Back at empty, the current suggestion (BRAVO) is still offered — clearing
    // restored the ghost rather than losing it.
    if (await accepted(bar) !== BRAVO) throw new Error('clearing the field did not bring the ghost suggestion back');
};
