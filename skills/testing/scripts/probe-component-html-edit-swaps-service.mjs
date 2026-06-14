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
//      <liquidos-file run path="service-a.js">
//      <p data-marker>SURVIVED_THE_SWAP</p>
//   2. Confirms SURVIVED_THE_SWAP is visible.
//   3. PUTs a new component.html with the run path swapped to
//      service-b.js — same marker content, no other change.
//   4. Asserts SURVIVED_THE_SWAP is STILL visible after the swap.
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

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Visibility: real area on screen, not display:none / hidden / opaque.
    const markerVisibility = () => page.evaluate(() => {
        const el = document.querySelector('[data-marker]');
        if (!el) return { visible: false, text: '' };
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const visible = r.width > 0 && r.height > 0
            && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
        return { visible, text: el.textContent || '' };
    });

    await page.waitForFunction(() =>
        document.querySelector('[data-marker]')?.textContent?.includes('SURVIVED_THE_SWAP'),
        undefined, { timeout: 10000 });

    const before = await markerVisibility();
    expect('baseline: view marker visible with SURVIVED_THE_SWAP',
        before.visible && before.text.includes('SURVIVED_THE_SWAP'),
        'before: ' + JSON.stringify(before));

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

    // Wait for the live DOM to reflect the swap — the new run-mode
    // liquidos-file (pointing at service-b.js) appears in the document.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const swapped = await page.evaluate(() =>
            !!document.querySelector('liquidos-file[path*="service-b.js"][run]')
            && !document.querySelector('liquidos-file[path*="service-a.js"][run]'));
        if (swapped) break;
        await sleep(120);
    }
    expect('swap propagated to the live DOM (service-b mounted, service-a removed)',
        await page.evaluate(() =>
            !!document.querySelector('liquidos-file[path*="service-b.js"][run]')
            && !document.querySelector('liquidos-file[path*="service-a.js"][run]')),
        'mount reconcile never propagated');

    // The whole point: did the rendered view survive the swap?
    const after = await markerVisibility();
    expect('after service swap: view marker STILL visible with SURVIVED_THE_SWAP',
        after.visible && after.text.includes('SURVIVED_THE_SWAP'),
        'the rendered view was torn down by the structural edit — after: ' + JSON.stringify(after));
};
