#!/usr/bin/env node
//
// probe-relationship-failure-surfaces-on-sender.mjs
//
// When a relationship's mount or connect fails, the user has to know
// something's wrong — they can't see the relationship itself (it has no
// UI), but they can see its sender. Convention: a relationship folder
// named "<sender>-to-<receiver>" is owned, from the user's perspective,
// by the sender component. A failure in the relationship shows up as a
// Repair button on the sender.
//
// The probe:
//   1. Boots the relationship-reload fixture (source → sink, working).
//   2. Asserts: no Repair button on the source.
//   3. Breaks the relationship by rewriting its functions.js so mount()
//      throws.
//   4. Asserts: the source's Repair button becomes visible on hover.
//
// The sink should NOT show a Repair button — it's the receiver, not the
// owner of this wire.
//

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'relationship-reload.liquidos');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture,
    '--app', appRoot
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sandbox = await new Promise((resolve, reject) => {
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

const cleanup = () => { try { launcher.kill('SIGTERM'); } catch {} };
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let exitCode = 0;
try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[page error]', err.message));

    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('liquidos-component[path="components/source"]', { timeout: 20000 });
    await page.waitForSelector('liquidos-component[path="components/sink"]', { timeout: 20000 });
    // Give the relationship a chance to mount + connect cleanly.
    await sleep(2000);

    const repairOn = async componentPath => {
        const frameSel = `liquidos-component[path="${componentPath}"] .harness-component-frame-watcher`;
        const frame = page.locator(frameSel).first();
        await frame.hover();
        await sleep(200);
        return page.locator(`liquidos-component[path="${componentPath}"] [data-runtime-repair-callback] button`).isVisible();
    };

    // --- Step 1: working relationship → no Repair button anywhere -------
    if (await repairOn('components/source')) {
        throw new Error('source already shows Repair before any failure');
    }
    if (await repairOn('components/sink')) {
        throw new Error('sink shows Repair before any failure');
    }
    console.log('initial: source + sink both clean (no Repair)');

    // --- Step 2: break the relationship ---------------------------------
    const fnPath = path.join(
        sandbox.workspace,
        'home/relationships/source-to-sink/functions.js'
    );
    fs.writeFileSync(fnPath, `
export const mount = () => {
    throw new Error('SIMULATED_RELATIONSHIP_FAILURE');
};
`);
    console.log('relationship broken — waiting for sender Repair to surface...');

    // --- Step 3: source's Repair must surface ---------------------------
    const senderRepair = await page.waitForFunction(
        () => {
            const cb = document.querySelector(
                'liquidos-component[path="components/source"] [data-runtime-repair-callback]'
            );
            return cb && !cb.hidden;
        },
        undefined,
        { timeout: 15000 }
    ).then(() => true).catch(() => false);
    if (!senderRepair) throw new Error('source Repair never surfaced after relationship broke');
    console.log('source: Repair surfaced (relationship failure attributed to sender)');

    // --- Step 4: sink must NOT show Repair (it's the receiver) ----------
    const receiverShows = await page.evaluate(() => {
        const cb = document.querySelector(
            'liquidos-component[path="components/sink"] [data-runtime-repair-callback]'
        );
        return cb && !cb.hidden;
    });
    if (receiverShows) throw new Error('sink showed Repair, but it is the receiver, not the relationship owner');
    console.log('sink: clean (receiver does not claim ownership)');

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
