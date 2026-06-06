#!/usr/bin/env node
//
// probe-browse-popularity.mjs
//
// UI test for the recipient-side popularity histogram rendered in the
// Browse overlay. Boots 3 publishers with the "clear consensus" bullet
// set from probe-popularity-tiers, dials them from the consumer, then
// drives the consumer's Browse overlay via Playwright and asserts the
// rendered histogram matches the expected counts.
//
// This probe covers the UI integration; probe-popularity-tiers covers
// the protocol surface and the JS clustering logic for multiple
// scenarios. Both share the popularity-publisher.liquidos fixture.
//

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const publisherFixture = path.join(scriptsDir, '..', 'fixtures', 'popularity-publisher.liquidos');
const consumerFixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-build.liquidos');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const BULLETS = {
    1: 'Show a list of restaurants nearby',
    2: 'Filter restaurants by cuisine',
    3: 'Show distance to each restaurant',
    4: 'Show photos of restaurants',
    5: 'Show reviews of restaurants',
    6: 'Reserve a table at restaurants',
    7: 'Save favorite restaurants'
};
const TOPIC = 'restaurants';

const PUBLISHERS = [
    { label: 'A', bulletIds: [1, 2, 3, 4] },
    { label: 'B', bulletIds: [1, 2, 3, 5] },
    { label: 'C', bulletIds: [1, 2, 6, 7] }
];

// Expected counts after recipient-side clustering across the 3 publishers.
const EXPECTED = [
    { count: 3, text: BULLETS[1] },
    { count: 3, text: BULLETS[2] },
    { count: 2, text: BULLETS[3] },
    { count: 1, text: BULLETS[4] },
    { count: 1, text: BULLETS[5] },
    { count: 1, text: BULLETS[6] },
    { count: 1, text: BULLETS[7] }
];

const requirementsFor = ids => ids.map(n => '- ' + BULLETS[n]).join('\n') + '\n';

const bootSandbox = async (fixture) => {
    const launcher = spawn('node', [
        path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
        '--workspace', fixture, '--app', appRoot, '--agent', 'none'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const handle = await new Promise((resolve, reject) => {
        let buf = '';
        const onExit = () => reject(new Error('sandbox exited before printing url'));
        launcher.on('exit', onExit);
        launcher.stdout.on('data', chunk => {
            buf += chunk.toString('utf8');
            const nl = buf.indexOf('\n');
            if (nl >= 0) {
                launcher.off('exit', onExit);
                try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
            }
        });
        launcher.stderr.on('data', c => process.stderr.write('[launcher] ' + c.toString('utf8')));
    });
    return { ...handle, launcher };
};

const publishers = [];
let consumer;
let browser;
const cleanup = () => {
    if (browser) { browser.close().catch(() => {}); }
    for (const p of publishers) { try { p.launcher.kill('SIGTERM'); } catch {} }
    if (consumer?.launcher) { try { consumer.launcher.kill('SIGTERM'); } catch {} }
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let exitCode = 0;
const fail = msg => { console.error('FAIL:', msg); exitCode = 1; };

try {
    // --- Boot publishers + write curated requirements ----------------
    for (const def of PUBLISHERS) {
        const handle = await bootSandbox(publisherFixture);
        const reqPath = path.join(handle.workspace, 'home/feature-requirements.txt');
        fs.writeFileSync(reqPath, requirementsFor(def.bulletIds));
        publishers.push({ ...handle, label: def.label });
        console.log('publisher ' + def.label + ':', handle.url);
    }

    // --- Share each publisher's home canvas --------------------------
    for (const pub of publishers) {
        const result = await fetch(pub.url + '/canvas/share', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ canvas: 'home', shared: true })
        }).then(r => r.json());
        if (result?.shared !== true) throw new Error('publisher ' + pub.label + ' did not flip to shared');
    }

    // --- Boot consumer, dial all publishers --------------------------
    consumer = await bootSandbox(consumerFixture);
    console.log('consumer:', consumer.url);

    const expectedPeerIds = new Set();
    for (const pub of publishers) {
        const status = await fetch(pub.url + '/network/status').then(r => r.json());
        expectedPeerIds.add(status.peerId);
        const addr = (status.multiaddrs || []).find(a => a.startsWith('/ip4/127.0.0.1/'));
        const dial = await fetch(consumer.url + '/network/dial', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ multiaddr: addr })
        }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
        if (!dial.ok) throw new Error('dial ' + pub.label + ' failed');
    }

    // Wait for the gossipsub cache to hold all 3 bundles before opening
    // the UI — the UI just renders whatever the search returns, so the
    // assertion is sharper if we know the cache is warm first.
    for (let i = 0; i < 60; i++) {
        await sleep(500);
        const search = await fetch(consumer.url + '/network/search?q=' + TOPIC + '&n=3&timeout_ms=0')
            .then(r => r.json());
        const bundles = (search.results || []).filter(r => r.peerId && expectedPeerIds.has(r.peerId));
        if (bundles.length >= 3) break;
    }

    // --- Drive the Browse overlay via Playwright --------------------
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto(consumer.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#new-canvas', { timeout: 20000 });
    await sleep(500);
    await page.locator('#new-canvas').dispatchEvent('click');
    await page.waitForSelector('#browse-overlay:not([hidden])', { timeout: 5000 });
    await page.locator('#browse-query').fill(TOPIC);

    // Wait for the popularity block to render (or fail loudly).
    try {
        await page.waitForSelector('.browse-popularity', { timeout: 10000 });
    } catch {
        throw new Error('.browse-popularity never appeared after typing the query');
    }

    // --- Assertions on the rendered histogram -----------------------
    const observed = await page.evaluate(() => {
        const block = document.querySelector('.browse-popularity');
        if (!block) return null;
        const sample = block.dataset.popularitySample;
        const rows = Array.from(block.querySelectorAll('.browse-popularity-row')).map(row => ({
            count: Number.parseInt(row.dataset.count, 10),
            text: row.querySelector('.browse-popularity-text')?.textContent || ''
        }));
        const heading = block.querySelector('.browse-popularity-heading')?.textContent || '';
        return { sample, heading, rows };
    });
    console.log('observed:', JSON.stringify(observed, null, 2));

    if (!observed) throw new Error('no .browse-popularity in the DOM');
    if (observed.sample !== '3') fail('expected sample size 3, got ' + observed.sample);
    if (!observed.heading.includes('3 results')) fail('expected heading to mention "3 results", got ' + observed.heading);

    // Same set of bullets + counts, regardless of sort order.
    const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const observedSet = new Set(observed.rows.map(r => r.count + '|' + norm(r.text)));
    const expectedSet = new Set(EXPECTED.map(r => r.count + '|' + norm(r.text)));
    for (const item of expectedSet) {
        if (!observedSet.has(item)) fail('missing expected row: ' + item);
    }
    for (const item of observedSet) {
        if (!expectedSet.has(item)) fail('unexpected row: ' + item);
    }

    if (exitCode === 0) console.log('PASS');
} catch (e) {
    console.error('THREW:', e.message);
    if (!exitCode) exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
