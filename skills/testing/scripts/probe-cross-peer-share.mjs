//
// probe-cross-peer-share.mjs
//
// End-to-end share + discover + install across two LiquidOS peers, driven
// through the UI the way a real user does it.
//
// Publisher: opens the canvas with a real component, clicks the Share toggle,
// opens the component's Requirements modal and verifies the per-component
// share switch reflects the inherited canvas state.
//
// Consumer: opens Browse, types the canvas name, picks the publisher's result,
// clicks Install. The install auto-switches the consumer to the new canvas.
// The probe opens the installed component's Requirements modal and asserts the
// sentinel requirement string from the publisher's fixture survives the full
// round-trip: through share.sh → peer-feed fetch → install.sh's scaffold →
// into the textarea the user reads.
//
// The two programmatic precursors that aren't user-reachable — a
// /network/status fetch to grab the publisher's loopback multiaddr, and
// /network/dial to skip libp2p DHT bootstrap — are test setup, not the thing
// under test.
//
// Two peers: the publisher is the wrapper's sandbox (the provided page drives
// it); the consumer is a second sandbox booted here and torn down in finally.
//
// Run it:  node run-probe.mjs probe-cross-peer-share.mjs
//

import { bootSandbox } from './sandbox.mjs';

export const fixture = 'canvas-switcher.liquidos'; // the publisher

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Must match the sentinel in
// fixtures/canvas-switcher.liquidos/home/components/gizmo/feature-requirements.txt
const GIZMO_SENTINEL = 'GIZMO_REQUIREMENT_SENTINEL';

export default async ({ url, page, browser }) => {
  const publisher = { url };
  const pubPage = page;
  const consumer = await bootSandbox('canvas-build.liquidos', { agent: 'none' });
  console.log('publisher:', publisher.url);
  console.log('consumer :', consumer.url);

  try {
    // --- publisher: share through the UI ----------------------------------
    pubPage.on('pageerror', err => console.log('[pub pageerror]', err.message));
    await pubPage.goto(publisher.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the gizmo component to actually render — without it, the share
    // has nothing meaningful to publish.
    await pubPage.waitForSelector('liquidos-component[path="components/gizmo"]', { timeout: 20000 });

    // The canvas-level Share toggle lives inside the Canvas Requirements modal
    // — open it via the Info button.
    await pubPage.locator('#canvas-reqs-toggle').click();
    await pubPage.locator('#canvas-share-switch').waitFor({ state: 'visible', timeout: 10000 });
    await pubPage.locator('#canvas-share-switch').click();
    // Wait for the server to actually accept the toggle, not just the
    // optimistic UI flip. The button stays disabled until the PUT
    // /share/<canvas> response lands (which is when share.sh has finished
    // publishing).
    await pubPage.waitForFunction(
      () => {
        const btn = document.getElementById('canvas-share-switch');
        return btn && btn.getAttribute('aria-checked') === 'true' && !btn.hasAttribute('disabled');
      },
      undefined,
      { timeout: 30000 }
    );
    console.log('publisher canvas share toggle: ON (server committed)');

    // Close the Canvas Requirements modal so the gizmo component is reachable
    // for the per-component check.
    await pubPage.locator('#canvas-requirements-cancel').click();
    await pubPage.waitForFunction(
      () => document.getElementById('canvas-requirements-overlay')?.hidden === true,
      undefined,
      { timeout: 5000 }
    );

    // Open gizmo's Requirements modal and check the per-component share switch
    // reflects the inherited canvas-level state (aria-checked=true, not
    // disabled).
    await pubPage.locator('liquidos-component[path="components/gizmo"] [data-component-flip]').click();
    await pubPage.waitForFunction(
      () => {
        const btn = document.querySelector('.requirements-overlay [data-component-share-switch]');
        return btn && btn.getAttribute('aria-checked') === 'true' && !btn.hasAttribute('disabled');
      },
      undefined,
      { timeout: 8000 }
    );
    console.log('publisher per-component share switch inherits ON');

    // Close the modal so the publisher is back at rest.
    await pubPage.locator('.requirements-overlay [data-feature-cancel]').click();
    await pubPage.waitForSelector('.requirements-overlay', { state: 'detached', timeout: 5000 });

    // --- setup: dial the publisher from the consumer ----------------------
    // libp2p DHT bootstrap is too slow for a probe; /network/dial is the
    // documented shortcut, and there's no UI for this — peer discovery is meant
    // to be automatic. This is test setup, not the thing under test.
    const pubStatus = await fetch(publisher.url + '/network/status').then(r => r.json());
    const pubMultiaddr = (pubStatus.multiaddrs || []).find(a => a.startsWith('/ip4/127.0.0.1/'));
    if (!pubMultiaddr) throw new Error('publisher reported no loopback multiaddr');
    console.log('dialing :', pubMultiaddr);
    const dial = await fetch(consumer.url + '/network/dial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ multiaddr: pubMultiaddr })
    }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
    if (!dial.ok) throw new Error('dial failed: ' + JSON.stringify(dial));

    // --- consumer: browse, install, verify the requirements survived ------
    const conPage = await browser.newPage();
    conPage.on('pageerror', err => console.log('[con pageerror]', err.message));
    await conPage.goto(consumer.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await conPage.waitForSelector('#canvas-overview-toggle', { timeout: 20000 });
    await sleep(1000);  // small settle for the grid wire-up

    // Open Browse via the canvas grid's "+ New" card, search for "home".
    await conPage.locator('#canvas-overview-toggle').dispatchEvent('click');
    await conPage.locator('#canvas-grid-new').dispatchEvent('click');
    await conPage.waitForSelector('#browse-overlay:not([hidden])', { timeout: 5000 });
    await conPage.locator('#browse-query').fill('home');

    // Wait for the publisher's bundle to surface in the UI. The consumer
    // fetches the publisher's feed on peer:connect (right after dial), so by
    // the time Browse opens the bundle should already be in the cache. Allow
    // some slack for that first fetch.
    await conPage.waitForFunction(
      (peerId) => Array.from(document.querySelectorAll('#browse-results .browse-result'))
        .some(c => c.dataset.peer === peerId),
      pubStatus.peerId,
      { timeout: 60000 }
    );
    console.log('consumer saw bundle in Browse UI');

    // Expand the result card and click Install.
    const resultSel = `#browse-results .browse-result[data-peer="${pubStatus.peerId}"]`;
    await conPage.locator(resultSel).click();
    await conPage.locator(`${resultSel} .browse-install`).click();

    // The install handler closes Browse and auto-switches to the new canvas, so
    // gizmo should now render on the consumer with the bundle's requirements.
    await conPage.waitForSelector('liquidos-component[path="components/gizmo"]', { timeout: 30000 });
    console.log('consumer rendered installed gizmo component');

    // Open the installed gizmo's Requirements modal and confirm the publisher's
    // sentinel text reached the textarea — the assertion that proves the
    // requirements survived share.sh → bundle → libp2p → install.sh → on-disk.
    await conPage.locator('liquidos-component[path="components/gizmo"] [data-component-flip]').click();
    await conPage.waitForFunction(
      (expected) => {
        const ta = document.querySelector('.requirements-overlay [data-feature-requirements]');
        return !!ta && ta.value.includes(expected);
      },
      GIZMO_SENTINEL,
      { timeout: 10000 }
    );
    console.log('consumer Requirements modal shows the sentinel');
  } finally {
    consumer.teardown();
  }
};
