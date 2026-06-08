#!/usr/bin/env node
//
// probe-component-share-opt-out.mjs
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
//   - /component/.../share POST doesn't republish the bundle
//   - share.sh ignores component-level share.json when building the bundle
//   - install.sh scaffolds every folder it finds in the TAR regardless
// All three are real product gaps the probe surfaces.
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

// Consumer boots with --agent=none so install's auto-Build dispatch
// fails loudly instead of running an agent. We only care about what
// install.sh scaffolds, not what an agent then builds on top.
const publisher = await bootSandbox(publisherFixture, 'none');
const consumer  = await bootSandbox(consumerFixture, 'none');
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
    await pubPage.waitForSelector('liquidos-component[path="components/widget"]', { timeout: 20000 });
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
    await pubPage.locator('#canvas-requirements-cancel').click();
    await pubPage.waitForFunction(
        () => document.getElementById('canvas-requirements-overlay')?.hidden === true,
        undefined,
        { timeout: 5000 }
    );
    console.log('publisher: canvas Shared ON');

    // --- publisher: opt widget OUT via its Requirements modal -------------
    await pubPage.locator('liquidos-component[path="components/widget"] [data-component-flip]').click();
    await pubPage.waitForSelector('.requirements-overlay [data-component-share-switch]', { timeout: 8000 });
    // Wait for the switch to populate as ON (inherited from canvas).
    await pubPage.waitForFunction(
        () => {
            const btn = document.querySelector('.requirements-overlay [data-component-share-switch]');
            return btn
                && btn.getAttribute('aria-checked') === 'true'
                && !btn.hasAttribute('disabled');
        },
        undefined,
        { timeout: 8000 }
    );
    // Click it off; wait for server-committed OFF state.
    await pubPage.locator('.requirements-overlay [data-component-share-switch]').click();
    await pubPage.waitForFunction(
        () => {
            const btn = document.querySelector('.requirements-overlay [data-component-share-switch]');
            return btn
                && btn.getAttribute('aria-checked') === 'false'
                && !btn.hasAttribute('disabled');
        },
        undefined,
        { timeout: 30000 }
    );
    console.log('publisher: widget Share toggled OFF');

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

    console.log('PASS');
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally {
    try { if (browser) await browser.close(); } catch {}
    cleanup();
    process.exit(exitCode);
}
