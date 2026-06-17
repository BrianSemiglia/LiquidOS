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
// FLAG: this is a genuine visibility test. After the fold the component's own
// content is gone from screen (that's the point of folding) so there's no
// content string to read; we assert the Requirements button is actually
// VISIBLE (rendered, non-zero box, not opacity/visibility-hidden), which is
// the user-facing guarantee. Keep it a visibility check, not a text check.
//
// Run it:  node run-probe.mjs probe-component-chrome-resilient.mjs
//

export const fixture = 'component-chrome-resilient.liquidos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    const onScreen = (text, timeout = 8000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });
    const offScreen = (text, timeout = 8000) => page.waitForFunction(
        t => !document.body.innerText.includes(t), text, { timeout });

    // The component's Requirements button is system chrome. Normally it lives
    // in the component's frame; when the card is folded the harness lifts it
    // into #component-chrome-layer. Either way it must stay visible — present,
    // a real box, not faded or visibility-hidden. Look for it anywhere.
    const requirementsVisible = () => page.evaluate(() => {
        const btn = document.querySelector('[data-component-flip]');
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

    const liftedIntoOverlay = () => page.evaluate(() =>
        !!document.querySelector('#component-chrome-layer [data-component-flip]'));

    // Baseline: the component is up, its Requirements button is shown, and it
    // lives in the component's own frame (NOT lifted into the overlay).
    if (!(await requirementsVisible())) {
        throw new Error('Requirements button not visible before the fold — baseline broken');
    }
    if (await liftedIntoOverlay()) {
        throw new Error('Requirements button lifted into the overlay before any fold — should sit in the component frame');
    }
    console.log('  ok  baseline: Requirements button shown, in-frame (not lifted)');

    // Fold the card — the canvas collapses an ancestor of the item. Dispatch
    // the event directly: the system chrome correctly sits on top, so a real
    // pointer click on a button beneath it would be intercepted.
    await page.locator('.crk-fold').first().dispatchEvent('click');

    // The fold puts opacity:0 / max-height:0 on an ancestor of the item — the
    // pill (display-toggled by the fold) appearing confirms the fold engaged.
    // The component's own content is now visually collapsed; in-component chrome
    // would have gone opacity:0 right along with it.
    await onScreen('FOLDED_PILL').catch(() => {
        throw new Error('card did not fold — pill never appeared');
    });
    const contentCollapsed = await page.evaluate(() => {
        const body = document.querySelector('.crk-card.is-folded > .crk-card-body');
        if (!body) return false;
        const cs = getComputedStyle(body);
        return parseFloat(cs.opacity) === 0 || body.getBoundingClientRect().height < 2;
    });
    if (!contentCollapsed) throw new Error('fold did not collapse the component body');
    console.log('  ok  card folded: component body collapsed, pill shown');

    // ...but the system Requirements button must still be visible — the
    // harness lifts it into the overlay rather than letting the fold take it.
    await sleep(200);
    if (!(await requirementsVisible())) {
        throw new Error('Requirements button vanished when the card folded — system chrome is not resilient to canvas/component DOM');
    }
    if (!(await liftedIntoOverlay())) {
        throw new Error('Requirements button stayed in the folded frame instead of lifting into the overlay');
    }
    console.log('  ok  Requirements button survived the fold (lifted into the overlay)');
};
