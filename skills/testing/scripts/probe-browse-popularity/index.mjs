//
// probe-browse-popularity
//
// UI test for the two-level recipient-side popularity histogram rendered
// in the Browse overlay. Boots 3 publishers, each carrying overlapping-
// but-distinct `restaurant-list` bullets; one also has a niche
// `wait-times` component so the outer cluster pass shows real divergence.
//
//   Publisher A: restaurant-list { 1, 2, 3, 4 }
//   Publisher B: restaurant-list { 1, 2, 3, 5 }
//   Publisher C: restaurant-list { 1, 2, 6, 7 } + wait-times { a, b }
//
// Expected histogram:
//   restaurant-list (3/3)
//     - bullet 1   3/3
//     - bullet 2   3/3
//     - bullet 3   2/3
//     - bullets 4–7  1/3 each
//   wait-times (1/3)
//     - bullet a   1/1
//     - bullet b   1/1
//
// Every action is driven through the actual UI: each publisher opens its
// Canvas Info modal and clicks the Shared toggle; the consumer opens the
// Browse overlay and types the search; the histogram is read out of the
// rendered DOM. The only programmatic precursor is `/network/dial` to
// short-circuit libp2p DHT bootstrap (no UI for that — peer discovery is
// designed to be automatic).
//
// Run it:  node run-probe.mjs probe-browse-popularity
//

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootSandbox } from '../sandbox.mjs';

export const fixture = './workspace.liquidos';
export const agent = 'agent/none-agent.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOPIC = 'restaurant';
const RESTAURANT_BULLETS = {
    1: 'Refresh button',
    2: 'Filter by cuisine',
    3: 'Show distance',
    4: 'Show photos',
    5: 'Show reviews',
    6: 'Reserve a table',
    7: 'Save favorites'
};
const WAIT_TIMES_BULLETS = {
    a: 'Current wait time',
    b: 'Notify when ready'
};

const PUBLISHERS = [
    { label: 'A', components: { 'restaurant-list': [1, 2, 3, 4] } },
    { label: 'B', components: { 'restaurant-list': [1, 2, 3, 5] } },
    { label: 'C', components: { 'restaurant-list': [1, 2, 6, 7], 'wait-times': ['a', 'b'] } }
];

const normalizeBullet = s => s
    .replace(/^[-*•\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

// Lay down a component: component.html at the folder root
// (referenced from index.json), feature-requirements.txt alongside.
// The publisher's UI mounts the component the same way a real canvas would.
const writeComponent = (workspace, name, bullets, lookup) => {
    const compDir = path.join(workspace, 'home', 'components', name);
    fs.mkdirSync(compDir, { recursive: true });
    fs.writeFileSync(
        path.join(compDir, 'feature-requirements.txt'),
        bullets.map(id => '- ' + lookup[id]).join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(compDir, 'component.html'),
        '<liquidos-component path="components/' + name + '">\n' +
        '    <div></div>\n' +
        '</liquidos-component>\n'
    );
    const indexPath = path.join(workspace, 'home', 'index.json');
    const input = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const compPath = 'components/' + name + '/component.html';
    if (!Array.isArray(input.components)) input.components = [];
    if (!input.components.includes(compPath)) input.components.push(compPath);
    fs.writeFileSync(indexPath, JSON.stringify(input, null, 2) + '\n');
};

import { sharingDisabled } from '../sharing.mjs';

export default async ({ url, page, browser }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (await sharingDisabled(page)) { console.log('[skip] sharing disabled — probe not applicable'); return; }
    await page.setViewportSize({ width: 1400, height: 900 });

    const publishers = [];
    const fail = msg => { throw new Error(msg); };

    try {
        // --- Boot publishers + populate components ----------------------
        for (const def of PUBLISHERS) {
            const handle = await bootSandbox(new URL('./publisher.liquidos', import.meta.url), { agent: 'agent/none-agent.js' });
            // Canvas-level requirements: minimal, just enough text to be
            // searchable on TOPIC even if the topic isn't in component names.
            fs.writeFileSync(
                path.join(handle.workspace, 'home/feature-requirements.txt'),
                '- ' + TOPIC + '\n'
            );
            for (const [name, ids] of Object.entries(def.components)) {
                const lookup = name === 'restaurant-list' ? RESTAURANT_BULLETS : WAIT_TIMES_BULLETS;
                writeComponent(handle.workspace, name, ids, lookup);
            }
            publishers.push({ ...handle, label: def.label });
            console.log(`publisher ${def.label}: ${handle.url}`);
        }

        // --- Share each publisher's home canvas through the UI ------------
        // One tab per publisher: open Canvas Info, click Shared, wait for the
        // switch to read checked AND enabled (server-committed, not just the
        // optimistic flip).
        for (const pub of publishers) {
            const tab = await browser.newPage();
            tab.on('pageerror', err => console.warn(`[${pub.label} pageerror]`, err.message));
            await tab.goto(pub.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await tab.getByRole('button', { name: 'Edit canvas requirements' }).waitFor({ timeout: 20000 });
            await tab.getByRole('button', { name: 'Edit canvas requirements' }).click();
            await tab.getByRole('switch', { name: 'Toggle sharing for this canvas' }).click();
            await tab.getByRole('switch', { name: 'Toggle sharing for this canvas', checked: true, disabled: false })
                .waitFor({ timeout: 30000 });
            console.log(`publisher ${pub.label}: share toggle ON`);
            await tab.close();
        }

        // --- Dial each publisher from the consumer (provided url) ---------
        const expectedPeerIds = new Set();
        for (const pub of publishers) {
            // /network/status to get the loopback multiaddr and peerId, and
            // /network/dial to skip libp2p DHT bootstrap. Both are
            // documented test-setup precursors with no UI equivalent.
            const status = await fetch(pub.url + '/network/status').then(r => r.json());
            expectedPeerIds.add(status.peerId);
            const addr = (status.multiaddrs || []).find(a => a.startsWith('/ip4/127.0.0.1/'));
            const dial = await fetch(url + '/network/dial', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ multiaddr: addr })
            }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
            if (!dial.ok) throw new Error(`dial ${pub.label} failed`);
        }

        // --- Drive the Browse overlay -------------------------------------
        page.on('pageerror', err => console.log('[pageerror]', err.message));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.getByRole('button', { name: 'Show all spaces' }).waitFor({ timeout: 20000 });
        await sleep(500);
        // Browse is reached via the canvas grid's "+ New" card.
        await page.getByRole('button', { name: 'Show all spaces' }).dispatchEvent('click');
        await page.locator('#canvas-grid-new').dispatchEvent('click');
        await page.waitForSelector('#browse-overlay:not([hidden])', { timeout: 5000 });
        await page.locator('#browse-query').fill(TOPIC);

        // Wait for the publisher bundles to surface in the Browse UI. Each
        // publisher's feed was fetched on peer:connect (right after dial);
        // the popularity block renders once we have multiple matches.
        await page.waitForFunction(
            (peerIds) => {
                const cards = document.querySelectorAll('#browse-results .browse-result');
                const seen = new Set();
                for (const c of cards) if (peerIds.includes(c.dataset.peer)) seen.add(c.dataset.peer);
                return seen.size >= 3;
            },
            Array.from(expectedPeerIds),
            { timeout: 60000 }
        );
        console.log('consumer saw all 3 publisher bundles in Browse');

        try {
            await page.waitForSelector('.browse-popularity', { timeout: 10000 });
        } catch {
            throw new Error('.browse-popularity never appeared after typing the query');
        }

        // --- Assertions on the rendered two-level histogram ---------------
        const observed = await page.evaluate(() => {
            const block = document.querySelector('.browse-popularity');
            if (!block) return null;
            const sample = block.dataset.popularitySample;
            const heading = block.querySelector('.browse-popularity-heading')?.textContent || '';
            const components = Array.from(block.querySelectorAll('.browse-popularity-component')).map(c => ({
                name: c.dataset.componentName,
                count: Number.parseInt(c.dataset.componentCount, 10),
                bullets: Array.from(c.querySelectorAll('.browse-popularity-row')).map(row => ({
                    count: Number.parseInt(row.dataset.count, 10),
                    text: row.querySelector('.browse-popularity-text')?.textContent || '',
                    checked: row.querySelector('.browse-popularity-pick')?.checked || false
                })),
                headerChecked: c.querySelector('.browse-popularity-component-pick')?.checked || false
            }));
            const installBtn = block.querySelector('.browse-popularity-install');
            const nameInput = block.querySelector('.browse-popularity-name');
            return {
                sample, heading, components,
                buttonExists: !!installBtn,
                hasNameInput: !!nameInput
            };
        });
        console.log('observed:', JSON.stringify(observed, null, 2));
        if (!observed) throw new Error('no .browse-popularity in the DOM');
        if (observed.sample !== '3') fail('expected sample size 3, got ' + observed.sample);
        if (!observed.heading.includes('3 results')) fail('expected heading to mention "3 results", got ' + observed.heading);
        if (!observed.buttonExists) fail('Build button missing');
        if (observed.hasNameInput) fail('name input should NOT be present — the agent names everything');

        const byName = Object.fromEntries(observed.components.map(c => [c.name, c]));

        // Outer cluster expectations.
        const rl = byName['restaurant-list'];
        if (!rl) fail('expected a restaurant-list component cluster');
        else {
            if (rl.count !== 3) fail('restaurant-list count: got ' + rl.count + ', expected 3');
            if (!rl.headerChecked) fail('restaurant-list header should default to checked');
            const expectedRL = new Set([
                '3|' + normalizeBullet(RESTAURANT_BULLETS[1]),
                '3|' + normalizeBullet(RESTAURANT_BULLETS[2]),
                '2|' + normalizeBullet(RESTAURANT_BULLETS[3]),
                '1|' + normalizeBullet(RESTAURANT_BULLETS[4]),
                '1|' + normalizeBullet(RESTAURANT_BULLETS[5]),
                '1|' + normalizeBullet(RESTAURANT_BULLETS[6]),
                '1|' + normalizeBullet(RESTAURANT_BULLETS[7])
            ]);
            const seenRL = new Set(rl.bullets.map(b => b.count + '|' + normalizeBullet(b.text)));
            for (const e of expectedRL) if (!seenRL.has(e)) fail('restaurant-list missing bullet: ' + e);
            for (const s of seenRL) if (!expectedRL.has(s)) fail('restaurant-list unexpected bullet: ' + s);
            if (!rl.bullets.every(b => b.checked)) fail('restaurant-list bullets should default to checked');
        }

        const wt = byName['wait-times'];
        if (!wt) fail('expected a wait-times component cluster');
        else {
            if (wt.count !== 1) fail('wait-times count: got ' + wt.count + ', expected 1');
            const expectedWT = new Set([
                '1|' + normalizeBullet(WAIT_TIMES_BULLETS.a),
                '1|' + normalizeBullet(WAIT_TIMES_BULLETS.b)
            ]);
            const seenWT = new Set(wt.bullets.map(b => b.count + '|' + normalizeBullet(b.text)));
            for (const e of expectedWT) if (!seenWT.has(e)) fail('wait-times missing bullet: ' + e);
            for (const s of seenWT) if (!expectedWT.has(s)) fail('wait-times unexpected bullet: ' + s);
        }
    } finally {
        for (const p of publishers) { try { p.teardown(); } catch {} }
    }
};
