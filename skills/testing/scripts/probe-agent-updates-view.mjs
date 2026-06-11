#!/usr/bin/env node
//
// probe-agent-updates-view.mjs
//
// The agent updates a component's view by writing the file the view
// renders from. A sequence of successive writes is each visible on
// screen, not just the final state. The path here is the canonical
// file write — the same thing `op="writeFile"` / `op="streamFile"`
// lqpatch markers land on disk. We exercise it directly through the
// harness's /workspace PUT endpoint, the same surface the agent's
// tools use.
//
// The probe writes three successive view.json values and asserts the
// rendered DOM is observed at each step (not just the last). If the
// view update path swallows intermediate states, the assertion for
// the missed step will fail.
//

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'agent-service-swap.liquidos');

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture, '--app', appRoot, '--agent', 'none'
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

const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

let exitCode = 0;
try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Baseline: the fixture renders SURVIVED_THE_SWAP from its initial view.json.
    await page.waitForFunction(() =>
        document.querySelector('[data-marker]')?.textContent?.includes('SURVIVED_THE_SWAP'),
        undefined, { timeout: 10000 });

    // Step through three successive view.json writes, the way the agent
    // would emit op="writeFile" three times in a row. We go through the
    // /workspace PUT endpoint so the file watcher + SSE + render path
    // fires the same way it does in production.
    const writeView = async (marker) => {
        const body = JSON.stringify({ title: 'T', html: '<p data-marker>' + marker + '</p>' });
        const r = await fetch(sandbox.url + '/workspace/home/components/target/view.json', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body
        });
        if (r.status !== 200) throw new Error('PUT failed with ' + r.status);
    };

    for (const marker of ['AGENT_STEP_1', 'AGENT_STEP_2', 'AGENT_STEP_3']) {
        await writeView(marker);
        await page.waitForFunction(
            m => document.querySelector('[data-marker]')?.textContent?.includes(m),
            marker, { timeout: 5000 });
        const seen = await page.evaluate(() =>
            document.querySelector('[data-marker]')?.textContent || '');
        expect('view shows ' + marker, seen.includes(marker),
            'live DOM marker text: ' + JSON.stringify(seen));
    }

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error(e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
