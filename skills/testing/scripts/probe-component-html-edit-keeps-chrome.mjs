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
//      renders (visible strings INITIAL and MARKER_BEFORE on screen).
//   2. PUT a slightly edited component.html via /workspace (add a benign
//      extra <liquidos-file> as a third child of <liquidos-component>).
//   3. Wait for the SSE workspace-file event to propagate.
//   4. Assert: INITIAL and MARKER_BEFORE are STILL visible on screen.
//
// Asserts only what a person sees on screen, never internal DOM structure
// or geometry.
//
// Run it:  node run-probe.mjs probe-component-html-edit-keeps-chrome.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './probe-component-html-edit-keeps-chrome.liquidos';
export const agent = 'component-html-edit-keeps-chrome';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    const onScreen = (text, timeout = 8000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });
    // The requirements button — the flip affordance the user reaches for to
    // open a component's requirements — is harness chrome on every component.
    // It has no text to read, but it's a real, user-facing thing, so assert
    // it's displayed directly. (Content lives in .surface; the flip button
    // lives in the chrome frame — a morph can drop the frame while keeping the
    // surface, which is exactly the bug where content stays but the button
    // disappears.)
    const requirementsButtonShown = () => page.evaluate(() =>
        !!document.querySelector('[data-component-flip]'));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!window.__lqpatch, undefined, { timeout: 10000 });

    // Sanity: both visible strings from the fixture are on screen.
    await onScreen('INITIAL', 10000).catch(() => {
        throw new Error('"INITIAL" never appeared — #target-status did not render');
    });
    await onScreen('MARKER_BEFORE').catch(() => {
        throw new Error('"MARKER_BEFORE" never appeared — component marker did not render');
    });
    if (!(await requirementsButtonShown())) {
        throw new Error('the requirements button is not displayed on the component');
    }
    console.log('  ok  baseline: INITIAL, MARKER_BEFORE, and the requirements button shown');

    // Edit component.html — add a third child (benign liquidos-file that
    // points at a nonexistent path; we only care about the shape change).
    const targetHtmlPath = path.join(workspace, 'home/components/target/component.html');
    const original = fs.readFileSync(targetHtmlPath, 'utf8');
    const edited = original.replace(
        '</liquidos-component>',
        '    <liquidos-file path="components/target/nope.txt"></liquidos-file>\n</liquidos-component>'
    );
    if (edited === original) throw new Error('FAIL: edit produced no change in component.html');

    // PUT through the harness endpoint so the file watcher and SSE fire
    // the same way they would for a real edit.
    const put = await fetch(url + '/workspace/home/components/target/component.html', {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: edited
    });
    if (put.status !== 200) throw new Error('FAIL: PUT returned HTTP ' + put.status);

    // Wait until the edit propagated — the new <liquidos-file> for the
    // added child appears in the document. This is a driving step: we need
    // to know the live render reacted before we assert the chrome survived.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const landed = await page.evaluate(() =>
            !!document.querySelector('liquidos-file[path="components/target/nope.txt"]'));
        if (landed) break;
        await sleep(120);
    }
    if (!await page.evaluate(() =>
        !!document.querySelector('liquidos-file[path="components/target/nope.txt"]'))) {
        throw new Error('FAIL: edit never reached the page — file watcher / SSE / morph did not fire');
    }
    console.log('  ok  edit propagated to the live DOM');

    // The point of this probe: after the file change, the content the user
    // was looking at must still be on screen.
    await onScreen('INITIAL').catch(() => {
        throw new Error('FAIL: "INITIAL" vanished after the component.html edit — chrome was torn down');
    });
    await onScreen('MARKER_BEFORE').catch(() => {
        throw new Error('FAIL: "MARKER_BEFORE" vanished after the component.html edit — rendered content was lost');
    });
    if (!(await requirementsButtonShown())) {
        throw new Error('the requirements button vanished after the component.html edit — the chrome frame was torn down even though the surface content survived');
    }
    console.log('  ok  after edit: content AND the requirements button still shown');
};
