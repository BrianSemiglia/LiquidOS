#!/usr/bin/env node
//
// probe-popularity-tiers.mjs
//
// End-to-end test for the recipient-side popularity-from-raw-data pattern
// (see notes/POPULARITY_FROM_RAW_DATA.md). Boots 3 publishers + 1 consumer.
// Each publisher's home/feature-requirements.txt is curated with a known
// bullet set:
//
//   Publisher A: bullets {1, 2, 3, 4}
//   Publisher B: bullets {1, 2, 3, 5}
//   Publisher C: bullets {1, 2, 6, 7}
//
// The consumer dials all three, lets gossipsub propagate, then runs a
// single /network/search call and clusters the bullets locally. The probe
// then asserts the expected tier split:
//
//   Core (3/3):    bullets 1, 2     (the shared subset across all peers)
//   Extras (2/3):  bullet 3         (popular optional piece)
//   Tail (1/3):    bullets 4, 5, 6, 7
//
// Validates that the existing /network/search surface already exposes
// enough raw data for recipient-side interpretation — no protocol-level
// signatures, clustering, or popularity records needed.
//

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const publisherFixture = path.join(scriptsDir, '..', 'fixtures', 'popularity-publisher.liquidos');
const consumerFixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-build.liquidos');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const BULLETS = {
    1: 'Show a list of restaurants nearby',
    2: 'Filter by cuisine type',
    3: 'Show distance from current location',
    4: 'Show photos of dishes',
    5: 'Show user reviews and ratings',
    6: 'Make reservations directly',
    7: 'Save favorite restaurants'
};

const PUBLISHERS = [
    { name: 'A', bulletIds: [1, 2, 3, 4] },
    { name: 'B', bulletIds: [1, 2, 3, 5] },
    { name: 'C', bulletIds: [1, 2, 6, 7] }
];

const requirementsFor = ids => ids.map(n => '- ' + BULLETS[n]).join('\n') + '\n';

// Recipient-side bullet normalization: lowercase, collapse whitespace,
// strip leading list markers. The point of the test is that the recipient
// (this probe) decides how to cluster — protocol just ships raw text.
const normalizeBullet = s => s
    .replace(/^[-*•\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const bootSandbox = async (fixture) => {
    const launcher = spawn('node', [
        path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
        '--workspace', fixture,
        '--app', appRoot,
        '--agent', 'none'
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
const cleanup = () => {
    for (const p of publishers) { try { p.launcher.kill('SIGTERM'); } catch {} }
    if (typeof consumer !== 'undefined' && consumer?.launcher) {
        try { consumer.launcher.kill('SIGTERM'); } catch {}
    }
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let consumer;
let exitCode = 0;
const fail = msg => { console.error('FAIL:', msg); exitCode = 1; };

try {
    // --- Boot 3 publishers, overwrite each one's requirements ----------
    for (const def of PUBLISHERS) {
        const handle = await bootSandbox(publisherFixture);
        const reqPath = path.join(handle.workspace, 'home/feature-requirements.txt');
        fs.writeFileSync(reqPath, requirementsFor(def.bulletIds));
        publishers.push({ ...handle, label: def.name, bulletIds: def.bulletIds });
        console.log(`publisher ${def.name} (${def.bulletIds.join(',')}): ${handle.url}`);
    }

    // --- Share each publisher's home canvas ----------------------------
    for (const pub of publishers) {
        const result = await fetch(pub.url + '/canvas/share', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ canvas: 'home', shared: true })
        }).then(r => r.json());
        if (result?.shared !== true) throw new Error(`publisher ${pub.label} did not flip to shared`);
    }

    // --- Boot consumer -------------------------------------------------
    consumer = await bootSandbox(consumerFixture);
    console.log(`consumer: ${consumer.url}`);

    // --- Dial every publisher from the consumer ------------------------
    const expectedPeerIds = new Set();
    for (const pub of publishers) {
        const status = await fetch(pub.url + '/network/status').then(r => r.json());
        expectedPeerIds.add(status.peerId);
        const addr = (status.multiaddrs || []).find(a => a.startsWith('/ip4/127.0.0.1/'));
        if (!addr) throw new Error(`publisher ${pub.label} reported no loopback multiaddr`);
        const dial = await fetch(consumer.url + '/network/dial', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ multiaddr: addr })
        }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
        if (!dial.ok) throw new Error(`dial publisher ${pub.label} failed: ${JSON.stringify(dial)}`);
    }

    // --- Wait for gossipsub to deliver every publisher's feed ----------
    let bundles = [];
    for (let i = 0; i < 60; i++) {
        await sleep(500);
        const search = await fetch(consumer.url + '/network/search?q=restaurants')
            .then(r => r.json()).catch(() => ({ results: [] }));
        bundles = (search.results || []).filter(r =>
            r.peerId && expectedPeerIds.has(r.peerId) && r.name === 'home');
        if (bundles.length >= PUBLISHERS.length) break;
    }
    console.log(`saw ${bundles.length} of ${PUBLISHERS.length} publisher bundles`);
    if (bundles.length < PUBLISHERS.length) {
        throw new Error(`consumer never saw all publishers via /network/search (got ${bundles.length})`);
    }

    // --- Recipient-side clustering (this is the agent's job in practice) -
    const histogram = new Map();
    for (const bundle of bundles) {
        const reqText = bundle.canvasRequirements || '';
        const seen = new Set(); // dedupe within a single file
        for (const rawLine of reqText.split('\n')) {
            const norm = normalizeBullet(rawLine);
            if (norm && !seen.has(norm)) {
                seen.add(norm);
                histogram.set(norm, (histogram.get(norm) || 0) + 1);
            }
        }
    }
    console.log('bullet histogram:');
    for (const [bullet, count] of histogram) console.log(`  ${count}/3  ${bullet}`);

    const total = bundles.length;
    const tiers = { core: [], extras: [], tail: [] };
    for (const [bullet, count] of histogram) {
        const ratio = count / total;
        if (ratio >= 0.99) tiers.core.push(bullet);
        else if (ratio >= 0.66) tiers.extras.push(bullet);
        else tiers.tail.push(bullet);
    }
    const sortedSet = a => a.slice().sort();
    const sameSet = (a, b) => a.length === b.length && sortedSet(a).every((v, i) => v === sortedSet(b)[i]);

    const expectedCore   = [1, 2].map(n => normalizeBullet('- ' + BULLETS[n]));
    const expectedExtras = [3].map(n => normalizeBullet('- ' + BULLETS[n]));
    const expectedTail   = [4, 5, 6, 7].map(n => normalizeBullet('- ' + BULLETS[n]));

    console.log('tiers:', tiers);
    if (!sameSet(tiers.core, expectedCore))     fail(`core mismatch: got ${JSON.stringify(tiers.core)} expected ${JSON.stringify(expectedCore)}`);
    if (!sameSet(tiers.extras, expectedExtras)) fail(`extras mismatch: got ${JSON.stringify(tiers.extras)} expected ${JSON.stringify(expectedExtras)}`);
    if (!sameSet(tiers.tail, expectedTail))     fail(`tail mismatch: got ${JSON.stringify(tiers.tail)} expected ${JSON.stringify(expectedTail)}`);

    if (exitCode === 0) console.log('PASS');
} catch (e) {
    console.error('THREW:', e.message);
    if (!exitCode) exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
