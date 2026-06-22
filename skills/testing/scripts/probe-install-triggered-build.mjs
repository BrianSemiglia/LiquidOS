//
// probe-install-triggered-build.mjs
//
// POST /share (install) enqueues a "Build this canvas and its components."
// job scoped to the newly-installed canvas. The probe asserts that:
//   - the install completes through the UI,
//   - the dispatched agent job actually runs,
//   - the agent's work reaches the user-facing DOM.
//
// The consumer boots with --agent=install-build-test, a stub runtime
// that handles the Build prompt by rewriting each scaffolded
// component's view.json with a sentinel marker. If the dispatch was
// dropped or the runtime never picked up the job, the marker never
// appears and the probe times out.
//
// Publisher: canvas-switcher.liquidos, agent none — provided by the wrapper.
// Consumer: canvas-build.liquidos, agent install-build-test — booted here.
//
// Run it:  node run-probe.mjs probe-install-triggered-build.mjs
//

import { bootSandbox } from './sandbox.mjs';

export const fixture = './probe-install-triggered-build.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page, browser }) => {
    const publisher = { url };
    const pubPage = page;
    const consumer = await bootSandbox(new URL('./probe-install-triggered-build-consumer.liquidos', import.meta.url), { agent: 'agent/test/install-build-test-agent.js' });
    console.log('publisher:', publisher.url);
    console.log('consumer :', consumer.url);

    try {
        // --- publisher: share through the UI ----------------------------------
        pubPage.on('pageerror', err => console.log('[pub pageerror]', err.message));
        await pubPage.goto(publisher.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await pubPage.waitForSelector('liquidos-component[path="components/gizmo"]', { timeout: 20000 });
        await pubPage.locator('#canvas-reqs-toggle').click();
        await pubPage.locator('#canvas-share-switch').waitFor({ state: 'visible', timeout: 10000 });
        await pubPage.locator('#canvas-share-switch').click();
        await pubPage.waitForFunction(
            () => {
                const btn = document.getElementById('canvas-share-switch');
                return btn
                    && btn.getAttribute('aria-checked') === 'true'
                    && !btn.hasAttribute('disabled');
            },
            undefined,
            { timeout: 30000 }
        );
        console.log('publisher: Shared ON');

        // --- setup: dial publisher from consumer ------------------------------
        const pubStatus = await fetch(publisher.url + '/network/status').then(r => r.json());
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
        await conPage.waitForSelector('#canvas-overview-toggle', { timeout: 20000 });
        await sleep(500);
        // Browse is reached via the canvas grid's "+ New" card.
        await conPage.locator('#canvas-overview-toggle').dispatchEvent('click');
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

        // The install auto-switches to the new canvas. Wait for the
        // scaffolded gizmo to render — initially with the "Loading…"
        // placeholder, before the agent has touched it.
        await conPage.waitForSelector(
            'liquidos-component[path="components/gizmo"]',
            { timeout: 30000 }
        );
        console.log('consumer: installed gizmo rendered (pre-agent)');

        // The POST /share (install) handler enqueued a "Build this canvas..."
        // job; the install-build-test agent should pick it up and rewrite
        // each component's view.json with the sentinel marker. The
        // workspace-file watcher then re-imports view.json and the surface
        // updates without a reload.
        await conPage.waitForFunction(
            () => !!document.querySelector('[data-install-build-marker="true"]'),
            undefined,
            { timeout: 30000 }
        );
        console.log('consumer: agent-built marker reached the DOM');
    } finally {
        consumer.teardown();
    }
};
