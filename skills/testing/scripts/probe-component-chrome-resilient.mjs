//
// probe-component-chrome-resilient.mjs
//
// User-visible bug: on the woof canvas, pressing a card's minimize button
// (which folds the card to a pill) made that component's "Requirements"
// button disappear. System chrome must survive whatever a canvas does to the
// component it decorates.
//
// Root cause: the Requirements button lives INSIDE the component's frame so it
// rides the card's transforms. A canvas folds a card by putting opacity:0 /
// max-height:0 / overflow:hidden on an ANCESTOR of the item — which hides every
// descendant, the system chrome included, and no z-index can escape an
// ancestor's opacity. The fix: while the frame is hidden, the harness lifts the
// chrome out into a harness-owned overlay (#component-chrome-layer) positioned
// just above the card's visible box — same "above" placement as in-frame — so a
// fold can't take it down, then lowers it back when the card returns.
//
// This fixture's canvas.js is a minimal stand-in for woof: a place() canvas
// with a "Fold" button that collapses an ancestor of the item exactly the way
// woof's minimize does.
//
// FLAG: after the fold the component's own content is gone from screen (that's
// the point of folding), so there's no content string to read. We keep a
// genuine VISIBILITY check that the Requirements button is actually visible
// (rendered, non-zero box, not opacity/visibility-hidden) — the user-facing
// "can the user see it" guarantee — and add a USABILITY check: a real pointer
// click on it opens the requirements editor (the component's title appears).
// We do NOT inspect which DOM layer the button sits in; that's the mechanism,
// not the user-facing outcome.
//
// Run it:  node run-probe.mjs probe-component-chrome-resilient.mjs
//

export const fixture = './probe-component-chrome-resilient.liquidos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    const onScreen = (text, timeout = 8000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });
    const offScreen = (text, timeout = 8000) => page.waitForFunction(
        t => !document.body.innerText.includes(t), text, { timeout });

    // The component's Requirements button is system chrome. When the card is
    // folded the harness must keep it visible to the user — present, a real box,
    // not faded or visibility-hidden. Located by its accessible name (the
    // component is "marker", so "Edit Marker requirements").
    const requirementsVisible = () => page.evaluate(() => {
        const btn = document.querySelector('[aria-label="Edit Marker requirements"]');
        if (!btn) return false;
        return btn.checkVisibility
            ? btn.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            : btn.getBoundingClientRect().width > 0;
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await onScreen('MARKER_CONTENT', 15000).catch(() => {
        throw new Error('component never rendered ("MARKER_CONTENT" not on screen)');
    });
    await sleep(400);

    // Baseline: the component is up and its Requirements button is shown.
    if (!(await requirementsVisible())) {
        throw new Error('Requirements button not visible before the fold — baseline broken');
    }
    console.log('  ok  baseline: Requirements button shown');

    // Fold the card — the canvas collapses an ancestor of the item, the way
    // woof's minimize does. Dispatch the event directly: the system chrome
    // correctly sits on top, so a real pointer click on a control beneath it
    // would be intercepted.
    await page.locator('.crk-fold').first().dispatchEvent('click');

    // The fold engaged: the pill appears (and the component's own content
    // collapses out of view — in-component chrome would have gone with it).
    await onScreen('FOLDED_PILL').catch(() => {
        throw new Error('card did not fold — pill never appeared');
    });
    console.log('  ok  card folded: pill shown');

    // The system Requirements button must SURVIVE the fold — still visible to
    // the user (not taken down with the card)...
    await sleep(200);
    if (!(await requirementsVisible())) {
        throw new Error('Requirements button vanished when the card folded — system chrome is not resilient to canvas/component DOM');
    }
    // ...and still USABLE: a real pointer click opens its requirements editor,
    // which shows the component's title ("Marker"). If the fold had taken the
    // button down (clipped/hidden), this click could not land — exactly the bug
    // this guards. We prove the outcome the user feels, not which layer it's in.
    try {
        await page.getByRole('button', { name: 'Edit Marker requirements' }).click({ timeout: 5000 });
    } catch {
        throw new Error('Requirements button was not clickable after the fold — chrome was taken down with the card');
    }
    await onScreen('Marker').catch(() => {
        throw new Error('the Requirements editor did not open after the fold — the button was not usable');
    });
    console.log('  ok  Requirements button survived the fold (visible and usable)');
};
