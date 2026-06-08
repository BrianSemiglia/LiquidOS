#!/usr/bin/env node
//
// probe-canvas-unshare.mjs
//
// Verifies the un-share half of the share toggle through the same UI a
// user sees. The cross-peer probe only ever flips Shared ON; this one
// flips it back OFF and asserts the consumer's Browse stops seeing the
// publisher's bundle.
//
// Flow:
//   1. Publisher: open Canvas Info → click Shared. Server runs share.sh,
//      rebroadcasts the feed.
//   2. Consumer: dial publisher (setup), open Browse, type the query.
//      Wait for the publisher's result card to appear.
//   3. Publisher: click Shared again. Server runs unshare.sh, rebroadcasts
//      the feed without the bundle.
//   4. Consumer: re-type the query (Browse re-queries on input). Assert
//      the publisher's result card disappears within a reasonable window.
//
// /network/dial is the documented test-setup precursor — peer discovery
// is meant to be automatic but DHT bootstrap is too slow for a probe.
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

const bootSandbox = async (fixture) => {
    const launcher = spawn('node', [
        path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
        '--workspace', fixture, '--app', appRoot
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
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

const publisher = await bootSandbox(publisherFixture);
const consumer  = await bootSandbox(consumerFixture);
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

    // --- consumer: open Browse, see the bundle ----------------------------
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
    console.log('consumer: publisher bundle visible in Browse');

    // --- publisher: unshare through the UI --------------------------------
    // Toggle is still on-screen since Canvas Info modal is still open.
    await pubPage.locator('#canvas-share-switch').click();
    await pubPage.waitForFunction(
        () => {
            const btn = document.getElementById('canvas-share-switch');
            return btn
                && btn.getAttribute('aria-checked') === 'false'
                && !btn.hasAttribute('disabled');
        },
        undefined,
        { timeout: 30000 }
    );
    console.log('publisher: Shared OFF (server committed)');

    // --- consumer: bundle disappears from Browse --------------------------
    // Network state propagates by polling — the consumer's feed cache
    // refreshes on a ~30s timer. Browse only re-searches when the input
    // event fires, so we re-type the query periodically and check the
    // rendered cards. Gives the cache up to ~75s to refresh, covering
    // worst-case repoll-interval alignment.
    const deadline = Date.now() + 75000;
    let visible = true;
    while (visible && Date.now() < deadline) {
        await conPage.locator('#browse-query').fill('');
        await conPage.locator('#browse-query').fill('home');
        // Let the debounced search run and results render.
        await sleep(800);
        visible = await conPage.evaluate((peerId) => {
            const cards = document.querySelectorAll('#browse-results .browse-result');
            return Array.from(cards).some(c => c.dataset.peer === peerId);
        }, pubStatus.peerId);
        if (visible) await sleep(2000);
    }
    if (visible) throw new Error('publisher bundle still in Browse after ' + Math.round((Date.now() - (deadline - 75000)) / 1000) + 's');
    console.log('consumer: publisher bundle no longer in Browse');

    console.log('PASS');
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally {
    try { if (browser) await browser.close(); } catch {}
    cleanup();
    process.exit(exitCode);
}
