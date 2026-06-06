#!/usr/bin/env node
//
// probe-popularity-tiers.mjs
//
// End-to-end test for the recipient-side popularity-from-raw-data pattern
// (see notes/POPULARITY_FROM_RAW_DATA.md). For each scenario in the table
// below, boots N publishers + 1 consumer, gives each publisher a curated
// feature-requirements.txt, shares, dials, then runs ONE call to
// /network/search?q=<topic>&n=<N>&timeout_ms=<ms> on the consumer. The
// endpoint polls its own gossipsub cache until either `n` matching
// bundles are present or `timeout_ms` elapses; the recipient clusters
// the bullets locally and the probe asserts the expected tier split.
//
// Scenarios cover the tier-boundary cases:
//   1. "clear consensus": well-defined core / extras / tail.
//   2. "full agreement": every publisher has identical bullets — pure core.
//   3. "no shared core": pairwise overlap only — no bullet in all peers,
//      everything lands in extras (2/3) or tail (1/3).
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

// Each bullet must contain the topic substring so that /network/search's
// substring filter matches every publisher's bundle regardless of which
// bullets it carries. The clustering downstream is exact-match per bullet,
// so distinct wording → distinct clusters as expected.
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

// Recipient-side bullet normalization. The point of the probe is that the
// recipient (this code, or an agent in production) decides how to cluster;
// the protocol just ships raw text.
const normalizeBullet = s => s
    .replace(/^[-*•\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const requirementsFor = ids => ids.map(n => '- ' + BULLETS[n]).join('\n') + '\n';
const bulletText = id => normalizeBullet('- ' + BULLETS[id]);

const SCENARIOS = [
    {
        name: 'clear consensus',
        publishers: [
            { label: 'A', bulletIds: [1, 2, 3, 4] },
            { label: 'B', bulletIds: [1, 2, 3, 5] },
            { label: 'C', bulletIds: [1, 2, 6, 7] }
        ],
        expectedCore:   [1, 2],
        expectedExtras: [3],
        expectedTail:   [4, 5, 6, 7]
    },
    {
        name: 'full agreement',
        publishers: [
            { label: 'A', bulletIds: [1, 2, 3] },
            { label: 'B', bulletIds: [1, 2, 3] },
            { label: 'C', bulletIds: [1, 2, 3] }
        ],
        expectedCore:   [1, 2, 3],
        expectedExtras: [],
        expectedTail:   []
    },
    {
        name: 'no shared core',
        publishers: [
            { label: 'A', bulletIds: [1, 2] },
            { label: 'B', bulletIds: [2, 3] },
            { label: 'C', bulletIds: [3, 1] }
        ],
        expectedCore:   [],
        expectedExtras: [1, 2, 3],
        expectedTail:   []
    }
];

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

const runScenario = async (scenario) => {
    console.log(`\n=== scenario: ${scenario.name} ===`);
    const publishers = [];
    let consumer;

    try {
        // --- Boot publishers, write curated requirements --------------
        for (const def of scenario.publishers) {
            const handle = await bootSandbox(publisherFixture);
            const reqPath = path.join(handle.workspace, 'home/feature-requirements.txt');
            fs.writeFileSync(reqPath, requirementsFor(def.bulletIds));
            publishers.push({ ...handle, label: def.label, bulletIds: def.bulletIds });
            console.log(`  publisher ${def.label} (${def.bulletIds.join(',')}): ${handle.url}`);
        }

        // --- Share each publisher's home canvas -----------------------
        for (const pub of publishers) {
            const result = await fetch(pub.url + '/canvas/share', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ canvas: 'home', shared: true })
            }).then(r => r.json());
            if (result?.shared !== true) throw new Error(`publisher ${pub.label} did not flip to shared`);
        }

        // --- Boot consumer, dial all publishers -----------------------
        consumer = await bootSandbox(consumerFixture);
        console.log(`  consumer: ${consumer.url}`);

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

        // --- One search call. Endpoint polls until n results or timeout. -
        const n = publishers.length;
        const url = new URL(consumer.url + '/network/search');
        url.searchParams.set('q', TOPIC);
        url.searchParams.set('n', String(n));
        url.searchParams.set('timeout_ms', '30000');
        const search = await fetch(url.toString()).then(r => r.json());
        const bundles = (search.results || []).filter(r =>
            r.peerId && expectedPeerIds.has(r.peerId) && r.name === 'home');
        console.log(`  search returned ${bundles.length}/${n} expected bundles`);
        if (bundles.length < n) throw new Error('consumer did not see all publishers within timeout');

        // --- Recipient-side bullet clustering -------------------------
        const histogram = new Map();
        for (const bundle of bundles) {
            const reqText = bundle.canvasRequirements || '';
            const seen = new Set();
            for (const rawLine of reqText.split('\n')) {
                const norm = normalizeBullet(rawLine);
                if (norm && !seen.has(norm)) {
                    seen.add(norm);
                    histogram.set(norm, (histogram.get(norm) || 0) + 1);
                }
            }
        }
        for (const [bullet, count] of histogram) console.log(`  ${count}/${n}  ${bullet}`);

        const tiers = { core: [], extras: [], tail: [] };
        for (const [bullet, count] of histogram) {
            const ratio = count / n;
            if (ratio >= 0.99) tiers.core.push(bullet);
            else if (ratio >= 0.66) tiers.extras.push(bullet);
            else tiers.tail.push(bullet);
        }

        const sortedSet = a => a.slice().sort();
        const sameSet = (a, b) =>
            a.length === b.length && sortedSet(a).every((v, i) => v === sortedSet(b)[i]);

        const expectedCore   = scenario.expectedCore.map(bulletText);
        const expectedExtras = scenario.expectedExtras.map(bulletText);
        const expectedTail   = scenario.expectedTail.map(bulletText);

        const problems = [];
        if (!sameSet(tiers.core, expectedCore))     problems.push(`core: got ${JSON.stringify(tiers.core)} expected ${JSON.stringify(expectedCore)}`);
        if (!sameSet(tiers.extras, expectedExtras)) problems.push(`extras: got ${JSON.stringify(tiers.extras)} expected ${JSON.stringify(expectedExtras)}`);
        if (!sameSet(tiers.tail, expectedTail))     problems.push(`tail: got ${JSON.stringify(tiers.tail)} expected ${JSON.stringify(expectedTail)}`);
        if (problems.length) throw new Error(problems.join(' | '));
        console.log('  ok');
    } finally {
        for (const p of publishers) { try { p.launcher.kill('SIGTERM'); } catch {} }
        if (consumer?.launcher) { try { consumer.launcher.kill('SIGTERM'); } catch {} }
        // Give launchers a moment to actually exit so subsequent scenarios
        // get fresh ports without races.
        await sleep(500);
    }
};

let exitCode = 0;
const failures = [];

for (const scenario of SCENARIOS) {
    try {
        await runScenario(scenario);
    } catch (e) {
        console.error(`  FAIL: ${scenario.name}: ${e.message}`);
        failures.push(scenario.name);
        exitCode = 1;
    }
}

console.log('\n=== summary ===');
console.log(`${SCENARIOS.length - failures.length}/${SCENARIOS.length} scenarios passed`);
if (failures.length) console.log('failed:', failures.join(', '));
else console.log('PASS');
process.exit(exitCode);
