//
// probe-service-reload-keeps-component-visible.mjs
//
// User-visible bug, reported live: clicking through the canvas (which
// causes a workspace edit + a service file rewrite) makes a component
// disappear from view until the page is reloaded. The thing the user
// notices is "the component is gone" — not anything about chrome,
// internal element nesting, or DOM trees. So this probe asserts on
// exactly that: after the harness goes through a real service-restart
// cycle, is the content still visible on screen?
//
// Flow under test:
//   1. Render the target component — component.html's marker AND #target-status
//      are visible on screen (non-zero size, not display:none / hidden /
//      opacity:0).
//   2. Drive the service-rewrite stub agent, which emits an op="writeFile"
//      patch against the component's service.sh.
//   3. The harness's run-mode liquidos-file detects service.sh changed
//      and calls scheduleRestart() — killing the old service and spawning
//      the new one.
//   4. Assert the same user-visible content is STILL on screen.
//
// Run it:  node run-probe.mjs probe-service-reload-keeps-component-visible.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './probe-service-reload-keeps-component-visible.liquidos';
export const agent = 'service-rewrite-stub';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, workspace, page }) => {
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!window.__lqpatch, undefined, { timeout: 10000 });

    const onScreen = (text) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout: 10000 });

    // Wait for both visible strings to appear on screen.
    await onScreen('MARKER_BEFORE').catch(() => {
        throw new Error('"MARKER_BEFORE" never appeared — component did not render');
    });
    await onScreen('INITIAL').catch(() => {
        throw new Error('"INITIAL" never appeared — #target-status did not render');
    });

    expect('baseline: MARKER_BEFORE on screen', true);
    expect('baseline: INITIAL on screen', true);

    // Dispatch — stub agent rewrites service.sh via op="writeFile".
    const token = 'REWRITE_' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const dispatch = await fetch(url + '/output', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            scope: 'components/target/component.html',
            prompt: 'REWRITE_TAG: ' + token
        })
    });
    expect('dispatch returned 204', dispatch.status === 204,
        'got HTTP ' + dispatch.status);

    // Wait for the script rewrite to land on disk so we know the
    // restart actually had something to react to.
    const servicePath = path.join(workspace, 'home/components/target/service.js');
    const writeDeadline = Date.now() + 10000;
    while (Date.now() < writeDeadline) {
        const body = fs.readFileSync(servicePath, 'utf8');
        if (body.includes(token)) break;
        await sleep(120);
    }
    expect('service.js on disk carries the rewrite tag',
        fs.readFileSync(servicePath, 'utf8').includes(token),
        'rewrite never reached disk');

    // Give the harness's scheduleRestart its 250ms debounce + spawn time.
    await sleep(1200);

    // Assert both visible strings are still on screen — the user-visible test.
    const markerPresent = await page.evaluate(() => document.body.innerText.includes('MARKER_BEFORE'));
    const statusPresent = await page.evaluate(() => document.body.innerText.includes('INITIAL'));
    expect('after service reload: MARKER_BEFORE still on screen', markerPresent,
        'component content disappeared after service restart');
    expect('after service reload: INITIAL still on screen', statusPresent,
        '#target-status disappeared after service restart');
};
