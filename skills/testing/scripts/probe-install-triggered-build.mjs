#!/usr/bin/env node
//
// probe-install-triggered-build.mjs
//
// /network/install enqueues a "Build this canvas and its components."
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

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const publisherFixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-switcher.liquidos');
const consumerFixture  = path.join(scriptsDir, '..', 'fixtures', 'canvas-build.liquidos');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const bootSandbox = async (fixture, agentKind) => {
    const args = [
        path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
        '--workspace', fixture, '--app', appRoot
    ];
    if (agentKind) args.push('--agent', agentKind);
    const launcher = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const handle = await new Promise((resolve, reject) => {
        let buf = '';
        const onExit = () => reject(new Error('sandbox launcher exited before printing url'));
        launcher.on('exit', onExit);
        launcher.stdout.on('data', chunk => {
            buf += chunk.toString('utf8');
            const nl = buf.indexOf('\n');
            if (nl >= 0) {
                launcher.off('exit', onExit);
                try { resolve(JSON.parse(buf.slice(0, nl))); }
                catch (e) { reject(new Error('non-json launcher output: ' + buf.slice(0, 200))); }
            }
        });
        launcher.stderr.on('data', c => process.stderr.write('[launcher] ' + c.toString('utf8')));
    });
    return { ...handle, launcher };
};

// Publisher runs no agent — we just need it to publish.
// Consumer runs install-build-test so the post-install dispatch has a
// runtime that will respond to the Build prompt.
const publisher = await bootSandbox(publisherFixture, 'none');
const consumer  = await bootSandbox(consumerFixture, 'install-build-test');
console.log('publisher:', publisher.url);
console.log('consumer :', consumer.url);

const cleanup = () => {
    try { publisher.launcher.kill('SIGTERM'); } catch {}
    try { consumer.launcher.kill('SIGTERM'); } catch {}
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });

let exitCode = 0;
let browser;
try {
    browser = await chromium.launch({ headless: true });

    // --- publisher: share through the UI ----------------------------------
    const pubPage = await browser.newPage();
    pubPage.on('pageerror', err => console.log('[pub pageerror]', err.message));
    await pubPage.goto(publisher.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pubPage.waitForSelector('liquidos-component[path="components/gizmo"]', { timeout: 20000 });
    await pubPage.locator('#canvas-info').click();
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
    await conPage.waitForSelector('#new-canvas', { timeout: 20000 });
    await sleep(500);
    await conPage.locator('#new-canvas').click();
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

    // The /network/install handler enqueued a "Build this canvas..."
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

    console.log('PASS');
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally {
    try { if (browser) await browser.close(); } catch {}
    cleanup();
    process.exit(exitCode);
}
