#!/usr/bin/env node
//
// probe-callback-dispatch.mjs
//
// Verifies that clicking a <liquidos-callback>-wrapped button in a
// component fires the harness's surface listener, queues an agent job
// with the callback's prompt + scope, and the dispatch loop runs the
// configured agent end-to-end.
//
// Uses the callback-dispatch-test agent (agent/test/callback-dispatch-
// agent.js) which writes the call's prompt + scope to
// <workspace>/.test-agent/callback-dispatch.json instead of calling an
// LLM. The probe reads that file and asserts:
//   - dispatch happened (file exists)
//   - the scope matches the component's canvas-relative path
//   - the prompt body contains the marker from the fixture
//

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'callback-dispatch.liquidos');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture,
    '--app', appRoot,
    '--agent', 'callback-dispatch-test'
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

console.log('sandbox url:      ', sandbox.url);
console.log('sandbox workspace:', sandbox.workspace);
console.log();

const cleanup = () => {
    try { launcher.kill('SIGTERM'); } catch {}
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let exitCode = 0;
try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[page error]', err.message));

    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-probe-btn]', { timeout: 20000 });
    await sleep(1500);

    // Real DOM click — the harness's surface listener catches the bubbled
    // liquidos:callback event and routes through submitPrompt → server queue
    // → the configured agent's run().
    await page.locator('[data-probe-btn]').dispatchEvent('click');

    const resultFile = path.join(sandbox.workspace, '.test-agent', 'callback-dispatch.json');
    let record = null;
    for (let i = 0; i < 50 && !record; i += 1) {
        await sleep(100);
        if (fs.existsSync(resultFile)) {
            try { record = JSON.parse(fs.readFileSync(resultFile, 'utf8')); }
            catch { /* still being written */ }
        }
    }

    if (!record) {
        throw new Error('agent never recorded a call — dispatch did not reach the runtime');
    }

    const scopeOk = typeof record.scope === 'string' && record.scope.endsWith('/components/probe');
    const promptOk = typeof record.promptBody === 'string' && record.promptBody.includes('PROBE_DISPATCH_MARKER');

    console.log('scope:      ', record.scope);
    console.log('promptBody: ', record.promptBody);

    if (!scopeOk) {
        console.error('FAIL: scope did not match expected — wanted suffix /components/probe');
        exitCode = 1;
    }
    if (!promptOk) {
        console.error('FAIL: prompt body did not contain marker PROBE_DISPATCH_MARKER');
        exitCode = 1;
    }
    if (!exitCode) console.log('PASS');

    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
