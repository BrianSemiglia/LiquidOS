//
// probe-component-share-opt-out
//
// Per-component Share opt-out, end-to-end via the UI.
//
// The publisher shares a canvas that has TWO components (gizmo + widget).
// Then in the widget's Requirements modal, the per-component Share switch
// is clicked OFF. The user's intent: widget should drop out of what
// peers can install.
//
// The consumer dials the publisher, opens Browse, and installs. The
// probe asserts the installed canvas contains gizmo but NOT widget —
// the user-facing outcome that "opt this one out" should produce.
//
// If the probe fails at the "widget should NOT be installed" assertion,
// the per-component opt-out is broken at one of:
//   - DELETE /share/<canvas>/<component> doesn't republish the bundle
//   - share.sh ignores component-level share.json when building the bundle
//   - install.sh scaffolds every folder it finds in the TAR regardless
// All three are real product gaps the probe surfaces.
//
// Run it:  node run-probe.mjs probe-component-share-opt-out
//
// NOTE: this probe boots a SECOND sandbox for the consumer internally.
// The provided `page` is used for the publisher; a second page is opened
// from the provided `browser` for the consumer.
//

import { bootSandbox } from '../sandbox.mjs';

export const fixture = './workspace.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page, browser }) => {
    const consumer = await bootSandbox(new URL('./consumer.liquidos', import.meta.url), { agent: 'agent/none-agent.js' });
    console.log('publisher:', url);
    console.log('consumer :', consumer.url);

    try {
        // --- publisher: share through the UI ----------------------------------
        const pubPage = page;
        pubPage.on('pageerror', err => console.log('[pub pageerror]', err.message));
        await pubPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await pubPage.waitForSelector('liquidos-component[path="components/gizmo"]', { timeout: 20000 });
        await pubPage.waitForSelector('liquidos-component[path="components/widget"]', { timeout: 20000 });
        await pubPage.getByRole('button', { name: 'Edit canvas requirements' }).click();
        await pubPage.getByRole('switch', { name: 'Toggle sharing for this canvas' }).click();
        // Server-committed ON, not just the optimistic flip: the switch reads
        // checked and is interactive again (no longer disabled mid-request).
        await pubPage.getByRole('switch', { name: 'Toggle sharing for this canvas', checked: true, disabled: false })
            .waitFor({ timeout: 30000 });
        await pubPage.locator('#canvas-requirements-cancel').click();
        // Overlay closed: its canvas share switch is no longer on screen.
        await pubPage.getByRole('switch', { name: 'Toggle sharing for this canvas' })
            .waitFor({ state: 'hidden', timeout: 5000 });
        console.log('publisher: canvas Shared ON');

        // --- publisher: opt widget OUT via its Requirements modal -------------
        await pubPage.getByRole('button', { name: 'Edit Widget requirements' }).click();
        // Wait for the switch to populate as ON (inherited from canvas), settled.
        const widgetShare = pubPage.locator('.requirements-overlay')
            .getByRole('switch', { name: 'Toggle sharing for this component' });
        await pubPage.locator('.requirements-overlay')
            .getByRole('switch', { name: 'Toggle sharing for this component', checked: true, disabled: false })
            .waitFor({ timeout: 8000 });
        // Click it off; wait for server-committed OFF state.
        await widgetShare.click();
        await pubPage.locator('.requirements-overlay')
            .getByRole('switch', { name: 'Toggle sharing for this component', checked: false, disabled: false })
            .waitFor({ timeout: 30000 });
        console.log('publisher: widget Share toggled OFF');

        // --- setup: dial publisher from consumer ------------------------------
        const pubStatus = await fetch(url + '/network/status').then(r => r.json());
        const pubMultiaddr = (pubStatus.multiaddrs || []).find(a => a.startsWith('/ip4/127.0.0.1/'));
        if (!pubMultiaddr) throw new Error('publisher reported no loopback multiaddr');
        const dial = await fetch(consumer.url + '/network/dial', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ multiaddr: pubMultiaddr })
        }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
        if (!dial.ok) throw new Error('dial failed: ' + JSON.stringify(dial));

        // --- consumer: browse, install ----------------------------------------
        const conPage = await browser.newPage();
        conPage.on('pageerror', err => console.log('[con pageerror]', err.message));
        await conPage.goto(consumer.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await conPage.getByRole('button', { name: 'Show all spaces' }).waitFor({ timeout: 20000 });
        await sleep(500);
        // Browse is reached via the canvas grid's "+ New" card.
        await conPage.getByRole('button', { name: 'Show all spaces' }).dispatchEvent('click');
        await conPage.locator('#canvas-grid-new').dispatchEvent('click');
        await conPage.waitForSelector('#browse-overlay:not([hidden])', { timeout: 5000 });
        await conPage.locator('#browse-query').fill('home');
        await conPage.waitForFunction(
            (peerId) => Array.from(document.querySelectorAll('#browse-results .browse-result'))
                .some(c => c.dataset.peer === peerId),
            pubStatus.peerId,
            { timeout: 60000 }
        );

        const resultSel = `#browse-results .browse-result[data-peer="${pubStatus.peerId}"]`;
        await conPage.locator(resultSel).click();
        await conPage.locator(`${resultSel} .browse-install`).click();

        // Auto-switches to the installed canvas. gizmo MUST appear (the
        // component the user kept shared).
        await conPage.waitForSelector(
            'liquidos-component[path="components/gizmo"]',
            { timeout: 30000 }
        );
        console.log('consumer: gizmo present in installed canvas');

        // widget MUST NOT appear — that's the user's opt-out. Give the
        // canvas paint a moment to settle so we're not racing the mount,
        // then assert the absence.
        await sleep(2000);
        const widgetPresent = await conPage.evaluate(
            () => !!document.querySelector('liquidos-component[path="components/widget"]')
        );
        if (widgetPresent) {
            throw new Error('widget was installed even though the user opted it out — per-component Share opt-out is not propagating through the bundle');
        }
        console.log('consumer: widget correctly absent from installed canvas');
    } finally {
        consumer.teardown();
    }
};
