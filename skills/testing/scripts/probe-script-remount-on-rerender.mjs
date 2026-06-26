//
// probe-script-remount-on-rerender.mjs
//
// A component's markup ships a placeholder state that its behavior script
// replaces on mount() with a live, process-produced result. When
// component.html is re-rendered live (an edit, or an agent forcing a fresh
// render to recover a mount), the fresh markup reintroduces the placeholder —
// and the inner <liquidos-file script> is identity-reused across the morph, so
// its mount doesn't re-run. Without a re-mount the live result never comes
// back until a full page reload.
//
// The probe only ever reads VISIBLE text: "behavior connected" is the
// string the behavior produces; "edition: …" is a static line the re-render
// changes (a stable signal the morph has landed, so we don't race it). No
// private attributes/structure — if the component's internals change but it
// still shows the same result, the test stands.
//
// Run it:  node run-probe.mjs probe-script-remount-on-rerender.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './probe-script-remount-on-rerender.liquidos';

const seesText = (page, text, timeout) =>
    page.waitForFunction(
        t => (visibleText() || '').includes(t),
        text,
        { timeout }
    );

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 1. The behavior ran on first paint → its live result is on screen.
    await seesText(page, 'behavior connected', 20000)
        .catch(() => { throw new Error('behavior did not run on first paint (no live status on screen)'); });
    console.log('first paint: live status shown');

    // 2. Re-render component.html by changing a visible static line
    //    (edition: alpha → edition: bravo). The markup still ships the
    //    "waiting" placeholder, so the morph resets the status line.
    const htmlPath = path.join(workspace, 'home', 'components', 'locker', 'component.html');
    fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, 'utf8').replace('edition: alpha', 'edition: bravo'));
    console.log('--- re-rendered component.html ---');

    // 3. Wait until the re-render has visibly landed (the new edition line is
    //    on screen) — the stable signal the morph reset the view. Only a
    //    script re-mount then restores the live status. Without the fix this
    //    times out, the screen still showing the placeholder.
    await seesText(page, 'edition: bravo', 10000)
        .catch(() => { throw new Error('re-render never landed (edition line did not update)'); });
    await seesText(page, 'behavior connected', 10000)
        .catch(() => { throw new Error('behavior did not re-run after re-render — live status never returned (the restart-required bug)'); });
    console.log('after re-render: live status shown again — behavior re-ran');
};
