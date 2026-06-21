//
// probe-component-html-edit-swaps-service.mjs
//
// The original disappear-on-edit symptom that started this whole arc:
// editing a component's component.html to swap which file a run-mode
// <liquidos-file> points at caused the entire component to vanish from
// the canvas until the page was reloaded. The morph layer treated
// component.html as a view and re-aligned positions, tearing down the
// hydrated children — including the view.json render the user was
// looking at.
//
// The user-visible expectation: I edit the wiring (point at a different
// service), the wiring updates, the view stays painted.
//
// This probe:
//   1. Renders a component whose component.html declares
//      <liquidos-file run path="service-a.js">, a static SURVIVED_THE_SWAP
//      marker, and a #svc region the running service paints into.
//   2. Confirms SURVIVED_THE_SWAP and service-a's SERVICE_A_LIVE are visible.
//   3. PUTs a new component.html with the run path swapped to service-b.js.
//   4. Asserts the swap is visible — SERVICE_B_LIVE now paints and
//      SERVICE_A_LIVE is gone (A torn down, B spawned) — AND SURVIVED_THE_SWAP
//      is STILL on screen (the view survived the structural edit).
//
// Asserts only what a person sees on screen — the markers the services paint
// and the static content — never internal DOM structure or geometry.
//
// Run it:  node run-probe.mjs probe-component-html-edit-swaps-service.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = 'agent-service-swap.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    const onScreen = (text, timeout = 10000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });
    const offScreen = (text, timeout = 10000) => page.waitForFunction(
        t => !document.body.innerText.includes(t), text, { timeout });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Baseline: the static marker is on screen, and service-a is running —
    // proven by the SERVICE_A_LIVE marker it paints into the component.
    await onScreen('SURVIVED_THE_SWAP').catch(() => {
        throw new Error('"SURVIVED_THE_SWAP" never appeared — component did not render');
    });
    await onScreen('SERVICE_A_LIVE').catch(() => {
        throw new Error('"SERVICE_A_LIVE" never appeared — service-a did not start/paint');
    });
    console.log('  ok  baseline: SURVIVED_THE_SWAP + SERVICE_A_LIVE visible');

    // Swap which service the run-mode liquidos-file points at by editing
    // component.html. This is the exact edit the user made (start.sh →
    // render.js) reduced to its bare structure.
    const targetHtmlPath = path.join(workspace, 'home/components/target/component.html');
    const original = fs.readFileSync(targetHtmlPath, 'utf8');
    const edited = original.replace('service-a.js', 'service-b.js');
    expect('edit changes component.html',
        edited !== original,
        'replace had no effect');

    const put = await fetch(url + '/workspace/home/components/target/component.html', {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: edited
    });
    expect('PUT returned 200', put.status === 200, 'got HTTP ' + put.status);

    // The swap is observable on screen: the new service paints SERVICE_B_LIVE
    // into the component, and the old service's SERVICE_A_LIVE stops (the
    // harness killed A and spawned B). No DOM/structure inspection — just what
    // the running services put on screen.
    await onScreen('SERVICE_B_LIVE').catch(() => {
        throw new Error('FAIL: "SERVICE_B_LIVE" never appeared — the swapped-in service did not start');
    });
    await offScreen('SERVICE_A_LIVE').catch(() => {
        throw new Error('FAIL: "SERVICE_A_LIVE" still on screen — the swapped-out service was not torn down');
    });
    console.log('  ok  swap visible: SERVICE_B_LIVE painting, SERVICE_A_LIVE gone');

    // The whole point: did the rendered view survive the swap?
    await onScreen('SURVIVED_THE_SWAP').catch(() => {
        throw new Error('FAIL: "SURVIVED_THE_SWAP" vanished after the service swap — rendered view was torn down by the structural edit');
    });
    console.log('  ok  after service swap: SURVIVED_THE_SWAP still visible');
};
