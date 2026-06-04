#!/usr/bin/env node
//
// probe-cross-peer-share.mjs
//
// End-to-end discovery + install across two LiquidOS peers. Boot two
// sandboxes (publisher and consumer), share a canvas on the publisher
// (which runs publish.sh and gossipsubs the new feed), dial the
// publisher from the consumer (libp2p DHT bootstrap is too slow for a
// probe; /network/dial is the manual shortcut), then on the consumer
// search and install. The new canvas should appear in the consumer's
// dropdown.
//
// This covers what the local-only probe-browse couldn't: that
// gossipsub actually broadcasts feeds, that the cache holds remote
// peers' bundles, and that /network/install with peerId !== null
// fetches the TAR over libp2p and runs import.sh.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
// Publisher sandbox starts from a canvas with non-empty
// requirements.txt so the export step produces something
// recognizable.
const publisherFixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-switcher.liquidos');
// Consumer sandbox starts empty; we just need a workspace shell.
const consumerFixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-build.liquidos');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const bootSandbox = async (fixture, agent) => {
    const args = [
        path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
        '--workspace', fixture, '--app', appRoot
    ];
    if (agent) args.push('--agent', agent);
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

const publisher = await bootSandbox(publisherFixture);
const consumer = await bootSandbox(consumerFixture);
console.log('publisher:', publisher.url);
console.log('consumer :', consumer.url);

const cleanup = () => {
    try { publisher.launcher.kill('SIGTERM'); } catch {}
    try { consumer.launcher.kill('SIGTERM'); } catch {}
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });

let exitCode = 0;
try {
    // 1. Publisher: share the "home" canvas. Backend runs publish.sh
    //    and gossipsubs the new feed.
    const pubShare = await fetch(publisher.url + '/canvas/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ canvas: 'home', shared: true })
    }).then(r => r.json());
    console.log('publisher share toggle:', pubShare);
    if (pubShare?.shared !== true) throw new Error('publisher did not flip to shared');

    // 2. Get the publisher's multiaddrs and dial from the consumer.
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

    // 3. Wait for gossipsub to deliver the publisher's feed. The
    //    subscription-change handler triggers a rebroadcast as soon
    //    as the mesh forms; usually a few seconds is enough.
    let foundResult = null;
    for (let i = 0; i < 60 && !foundResult; i += 1) {
        await sleep(500);
        const search = await fetch(consumer.url + '/network/search?q=home').then(r => r.json()).catch(() => ({ results: [] }));
        foundResult = (search.results || []).find(r => r.peerId === pubStatus.peerId && r.name === 'home');
    }
    if (!foundResult) throw new Error('consumer never saw the publisher\'s bundle in /network/search');
    console.log('consumer saw bundle:', foundResult.name, 'from peer', foundResult.peerId.slice(0, 12) + '…', 'hash', foundResult.hash.slice(0, 20) + '…');

    // 4. Drive Install from the consumer's Browse UI.
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(consumer.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#new-canvas', { timeout: 20000 });
    await sleep(1000);
    await page.locator('#new-canvas').dispatchEvent('click');
    await page.waitForSelector('#browse-overlay:not([hidden])', { timeout: 5000 });
    await page.locator('#browse-query').fill('home');
    await page.waitForFunction(
        (peerId) => {
            const cards = document.querySelectorAll('#browse-results .browse-result');
            return Array.from(cards).some(c => c.dataset.peer === peerId);
        },
        pubStatus.peerId,
        { timeout: 8000 }
    );
    // Expand the result and click Install.
    await page.locator(`#browse-results .browse-result[data-peer="${pubStatus.peerId}"]`).dispatchEvent('click');
    await page.locator(`#browse-results .browse-result[data-peer="${pubStatus.peerId}"] .browse-install`).dispatchEvent('click');

    const expectedCanvas = 'home-' + foundResult.hash.slice('sha256-'.length, 'sha256-'.length + 6);
    await page.waitForFunction(
        (target) => Array.from(document.querySelectorAll('#canvas-select option')).some(o => o.textContent.trim() === target),
        expectedCanvas,
        { timeout: 30000 }
    );
    const options = await page.locator('#canvas-select option').allTextContents();
    console.log('canvases on consumer after install:', options);
    if (!options.map(s => s.trim()).includes(expectedCanvas)) {
        throw new Error('installed canvas did not surface in the consumer dropdown');
    }
    await browser.close();
    console.log('PASS');
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
