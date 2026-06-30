//
// probe-install-collision-keeps-existing.mjs
//
// Requirement: installing a shared canvas must never destroy or merge into a
// canvas the user already has. The sharing skill states it plainly — install
// "errors if the canvas name is taken" so "the import shouldn't silently merge
// into a canvas the user may be using." This probe asserts the user-visible
// half of that contract: after a colliding install, the already-installed
// canvas is still there, intact, with its component and requirements.
//
// The only collision reachable through the real Browse -> Install UI is
// installing the SAME bundle twice: POST /share derives the target canvas name
// as `<bundle>-<hash[:6]>`, so a second install of the same hash maps to the
// same name and collides with the first. (A cross-bundle name clash can't
// happen through the UI because of that hash suffix — but the safety
// requirement is the same, so this is the faithful way to exercise it.)
//
// We assert the REQUIREMENT, not today's mechanism: the first installation
// survives the second, colliding attempt — proven across a reload, so it's the
// on-disk canvas that's intact, not just a stale client.
//
// Two peers, like probe-cross-peer-share: the publisher is the wrapper's
// sandbox; the consumer is booted here and torn down in finally. The
// /network/status + /network/dial calls are test setup (no UI for peer
// discovery), not the thing under test.
//
// Run it:  node run-probe.mjs probe-install-collision-keeps-existing.mjs
//

import { bootSandbox } from './sandbox.mjs';

export const fixture = './probe-install-collision-keeps-existing.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Must match the sentinel in
// fixtures/canvas-switcher.liquidos/home/components/gizmo/feature-requirements.txt
const GIZMO_SENTINEL = 'GIZMO_REQUIREMENT_SENTINEL';

export default async ({ url, page, browser }) => {
  const publisher = { url };
  const pubPage = page;
  const consumer = await bootSandbox(new URL('./probe-install-collision-keeps-existing-consumer.liquidos', import.meta.url), { agent: 'agent/none-agent.js' });
  console.log('publisher:', publisher.url);
  console.log('consumer :', consumer.url);

  // Reusable: open Browse, search, expand the publisher's result, click Install.
  const installFromBrowse = async (conPage, peerId) => {
    await conPage.getByRole('button', { name: 'Show all spaces' }).dispatchEvent('click');
    await conPage.locator('#canvas-grid-new').dispatchEvent('click');
    await conPage.waitForSelector('#browse-overlay:not([hidden])', { timeout: 5000 });
    await conPage.locator('#browse-query').fill('home');
    await conPage.waitForFunction(
      (pid) => Array.from(document.querySelectorAll('#browse-results .browse-result'))
        .some(c => c.dataset.peer === pid),
      peerId,
      { timeout: 60000 }
    );
    const resultSel = `#browse-results .browse-result[data-peer="${peerId}"]`;
    await conPage.locator(resultSel).click();
    await conPage.locator(`${resultSel} .browse-install`).click();
  };

  const currentCanvas = (peerUrl) =>
    fetch(peerUrl + '/canvases').then(r => r.json()).then(d => d.current);

  try {
    // --- publisher: share through the UI ----------------------------------
    pubPage.on('pageerror', err => console.log('[pub pageerror]', err.message));
    await pubPage.goto(publisher.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pubPage.waitForSelector('liquidos-component[path="components/gizmo"]', { timeout: 20000 });

    await pubPage.getByRole('button', { name: 'Edit canvas requirements' }).click();
    await pubPage.getByRole('switch', { name: 'Toggle sharing for this canvas' }).click();
    // Server-committed ON: checked and interactive again (not disabled mid-PUT).
    await pubPage.getByRole('switch', { name: 'Toggle sharing for this canvas', checked: true, disabled: false })
      .waitFor({ timeout: 30000 });
    console.log('publisher canvas shared (server committed)');

    // --- setup: dial the publisher from the consumer ----------------------
    const pubStatus = await fetch(publisher.url + '/network/status').then(r => r.json());
    const pubMultiaddr = (pubStatus.multiaddrs || []).find(a => a.startsWith('/ip4/127.0.0.1/'));
    if (!pubMultiaddr) throw new Error('publisher reported no loopback multiaddr');
    const dial = await fetch(consumer.url + '/network/dial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ multiaddr: pubMultiaddr })
    }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
    if (!dial.ok) throw new Error('dial failed: ' + JSON.stringify(dial));

    // --- consumer: first install ------------------------------------------
    const conPage = await browser.newPage();
    conPage.on('pageerror', err => console.log('[con pageerror]', err.message));
    await conPage.goto(consumer.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await conPage.getByRole('button', { name: 'Show all spaces' }).waitFor({ timeout: 20000 });
    await sleep(1000);

    await installFromBrowse(conPage, pubStatus.peerId);
    await conPage.waitForSelector('liquidos-component[path="components/gizmo"]', { timeout: 30000 });

    // The canvas the first install created and auto-switched to. This is the
    // installation the second, colliding attempt must not damage.
    const installedCanvas = await currentCanvas(consumer.url);
    if (!installedCanvas) throw new Error('could not determine the installed canvas name');
    console.log('first install landed as canvas:', installedCanvas);

    // --- consumer: second, colliding install ------------------------------
    // Same bundle, same hash -> same target name -> collides with the canvas
    // we just installed. We don't assert how the collision is reported (today
    // it errors); the requirement is only that it must not clobber the first.
    try {
      await installFromBrowse(conPage, pubStatus.peerId);
    } catch (error) {
      console.log('second install click path threw (tolerated):', error.message);
    }
    await sleep(2000); // let the install attempt settle on the server
    console.log('second (colliding) install attempted');

    // --- assert the requirement: first installation survives --------------
    // Reload so we are asserting against the on-disk canvas, not stale client
    // state. The grid view persists across the reload, so the installed canvas's
    // card is already shown — switch to it the way a user would.
    await conPage.reload({ waitUntil: 'domcontentloaded' });
    const card = conPage.getByRole('button', { name: `Open ${installedCanvas} space` });
    await card.waitFor({ timeout: 20000 });
    await card.dispatchEvent('click');

    // The installed component must still render on the surviving canvas.
    await conPage.waitForSelector('liquidos-component[path="components/gizmo"]', { timeout: 30000 });
    console.log('surviving canvas still renders the installed component');

    // ...and its requirements must still be intact (not blanked or merged).
    await conPage.getByRole('button', { name: 'Edit Gizmo requirements' }).click();
    await conPage.waitForFunction(
      (expected) => {
        const ta = document.querySelector('.requirements-overlay [data-feature-requirements]');
        return !!ta && ta.value.includes(expected);
      },
      GIZMO_SENTINEL,
      { timeout: 10000 }
    );
    console.log('surviving canvas still shows the original requirement — not clobbered');
  } finally {
    consumer.teardown();
  }
};
