//
// probe-service-reload-keeps-component-visible
//
// User-visible bug, reported live: clicking through the canvas (which
// causes a workspace edit + a service file rewrite) makes a component
// disappear from view until the page is reloaded. The thing the user
// notices is "the component is gone" — not anything about chrome,
// internal element nesting, or DOM trees. So this probe asserts on
// exactly that: after the harness goes through a real service-restart
// cycle, is the content still visible on screen?
//
// Driven entirely through the UI, the way the user hit it:
//   - `target` is the component under test. Its view (MARKER_BEFORE,
//     INITIAL) is inert — nothing in it paints — so the only thing that
//     could remove that content is the bug.
//   - Clicking "Restart service" in the separate `controls` component
//     fires, through a relationship, a rewrite of target/service.js. The
//     harness's run-mode liquidos-file sees the change and restarts the
//     service (kill + respawn).
//   - The restarted service bumps a BOOT counter shown in `controls` —
//     a restart proof kept OUT of the target, so it can't mask or
//     confound the disappear it's checking for.
//
// Assert: BOOT ticks up (a restart really happened — no vacuous pass) AND
// the target's content is still on screen.
//
// Run it:  node run-probe.mjs probe-service-reload-keeps-component-visible
//

export const fixture = './workspace.liquidos';

const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const onScreen = (text) => page.waitForFunction(
        t => visibleText().includes(t), text, { timeout: 10000 });
    const bootCount = () => page.evaluate(() => {
        const m = visibleText().match(/BOOT (\d+)/);
        return m ? Number(m[1]) : 0;
    });

    // Baseline: the target's content is on screen and its service has booted
    // at least once (controls reads BOOT >= 1).
    await onScreen('MARKER_BEFORE').catch(() => {
        throw new Error('"MARKER_BEFORE" never appeared — target did not render');
    });
    await onScreen('INITIAL').catch(() => {
        throw new Error('"INITIAL" never appeared — #target-status did not render');
    });
    await page.waitForFunction(() => /BOOT [1-9]/.test(visibleText()), undefined, { timeout: 10000 });

    // The reported scenario: a click, wired through a relationship, rewrites
    // the target's service file — the harness restarts the service.
    const before = await bootCount();
    await page.getByRole('button', { name: 'Restart service' }).click();

    // The restart really happened: the new service boots and ticks the count.
    // No restart → no new BOOT → this waits out, so the probe can't pass while
    // doing nothing.
    await page.waitForFunction(
        prev => { const m = visibleText().match(/BOOT (\d+)/); return !!m && Number(m[1]) > prev; },
        before, { timeout: 15000 });

    // The bug: the target's content must NOT vanish across that restart.
    expect('after service restart: MARKER_BEFORE still on screen',
        await page.evaluate(() => visibleText().includes('MARKER_BEFORE')),
        'target content disappeared after service restart');
    expect('after service restart: INITIAL still on screen',
        await page.evaluate(() => visibleText().includes('INITIAL')),
        '#target-status disappeared after service restart');
};
