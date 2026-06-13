//
// probe-component-html-edit-keeps-chrome.mjs
//
// User-visible bug: editing a component's component.html (the *outer*
// authored markup) causes the whole component to vanish from the canvas
// until the page is reloaded.
//
// Root cause: liquidos-component's connectedCallback runs buildShell(),
// which wraps the authored children in a section.item > .frame > .surface
// chrome and appends it as a direct child of the liquidos-component. Then
// when the outer liquidos-file (the one whose path is the component.html
// itself) sees the file change, it calls morph(). morph diffs the live
// liquidos-component's children ([section.item]) against the parsed
// file's children ([<liquidos-file>, …]). The first position is
// SECTION vs LIQUIDOS-FILE — nodeName differs, so morphNode does
// replaceWith and the entire chrome (including the .surface and all
// rendered content) is destroyed. liquidos-component's connectedCallback
// won't run again (it short-circuits on _initialized), so the chrome is
// never rebuilt and the component stays blank.
//
// This probe forces the bug by:
//   1. Boot the agent-edit-stub fixture and confirm the target component
//      renders (#target-status visible, .surface in the DOM).
//   2. PUT a slightly edited component.html via /workspace (add a benign
//      extra <liquidos-file> as a third child of <liquidos-component>).
//   3. Wait for the SSE workspace-file event to propagate.
//   4. Assert: the chrome (.surface) is STILL in the DOM, and
//      #target-status is STILL visible.
//
// Run it:  node run-probe.mjs probe-component-html-edit-keeps-chrome.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = 'agent-edit-stub.liquidos';
export const agent = 'lqpatch-stream-stub';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!window.__lqpatch, undefined, { timeout: 10000 });
    await page.waitForSelector('#target-status', { timeout: 10000 });

    // Sanity: the user-visible content of the component is on screen.
    // We treat "visible to the user" as: element exists, has non-zero
    // size on screen, and isn't hidden via display:none / visibility:hidden.
    const visibility = () => page.evaluate(() => {
        const visible = el => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
            return true;
        };
        const status = document.getElementById('target-status');
        const marker = document.querySelector('[data-marker]');
        return {
            statusVisible: visible(status),
            statusText: status?.textContent || '',
            markerVisible: visible(marker),
            markerText: marker?.textContent || ''
        };
    });

    const before = await visibility();
    expect('baseline: #target-status is visible on screen with INITIAL',
        before.statusVisible && before.statusText.includes('INITIAL'),
        'before: ' + JSON.stringify(before));
    expect('baseline: view.json marker is visible on screen with MARKER_BEFORE',
        before.markerVisible && before.markerText.includes('MARKER_BEFORE'),
        'before: ' + JSON.stringify(before));

    // Edit component.html — add a third child (benign liquidos-file that
    // points at a nonexistent path; we only care about the shape change).
    const targetHtmlPath = path.join(workspace, 'home/components/target/component.html');
    const original = fs.readFileSync(targetHtmlPath, 'utf8');
    const edited = original.replace(
        '</liquidos-component>',
        '    <liquidos-file path="components/target/nope.txt"></liquidos-file>\n</liquidos-component>'
    );
    expect('edit produced a different file',
        edited !== original,
        'edit had no effect');

    // PUT through the harness endpoint so the file watcher and SSE fire
    // the same way they would for a real edit.
    const put = await fetch(url + '/workspace/home/components/target/component.html', {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: edited
    });
    expect('PUT returned 200', put.status === 200, 'got HTTP ' + put.status);

    // Wait until the edit propagated — the new <liquidos-file> for the
    // added child appears in the document. That's the user-visible
    // signal that the live render reacted to the file change.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const landed = await page.evaluate(() =>
            !!document.querySelector('liquidos-file[path="components/target/nope.txt"]'));
        if (landed) break;
        await sleep(120);
    }
    expect('edit propagated to the live DOM',
        await page.evaluate(() =>
            !!document.querySelector('liquidos-file[path="components/target/nope.txt"]')),
        'edit never reached the page — file watcher / SSE / morph did not fire');

    // The point of this probe: after the file change, is the content
    // the user was looking at still on screen?
    const after = await visibility();
    expect('after edit: #target-status is STILL visible on screen with INITIAL',
        after.statusVisible && after.statusText.includes('INITIAL'),
        'the user lost the component\'s status text — after: ' + JSON.stringify(after));
    expect('after edit: view.json marker is STILL visible on screen with MARKER_BEFORE',
        after.markerVisible && after.markerText.includes('MARKER_BEFORE'),
        'the user lost the component\'s rendered view content — after: ' + JSON.stringify(after));
};
