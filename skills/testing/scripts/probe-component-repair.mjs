#!/usr/bin/env node
//
// probe-component-repair.mjs
//
// User opens a flip-back whose feature-requirements.txt is empty,
// clicks the Repair button → agent dispatched → agent writes the
// requirements file. User closes the flip-back and reopens it; the
// harness re-fetches the file and the textarea now shows the agent's
// content. Probe asserts on that textarea value (UI surface).

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'component-repair.liquidos');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture, '--app', appRoot, '--agent', 'component-repair-test'
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

let exitCode = 0;
try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-probe]', { timeout: 20000 });
    await sleep(1500);

    // Open the flip-back. Textarea loads (empty); Repair surfaces.
    await page.locator('[data-component-flip]').first().dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const cb = document.querySelector('[data-feature-recover-callback]');
            return cb && !cb.hidden;
        },
        { timeout: 5000 }
    );

    // Click Repair → dispatched.
    await page.locator('[data-feature-recover]').dispatchEvent('click');
    // Give the agent time to write the file.
    await sleep(500);

    // Close (returns to front via the Cancel button).
    await page.locator('[data-feature-cancel]').dispatchEvent('click');
    await sleep(300);
    // Reopen — harness re-fetches via /component/<path>/features so the
    // textarea now reflects the agent's write.
    await page.locator('[data-component-flip]').first().dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const ta = document.querySelector('[data-feature-requirements]');
            return ta && ta.value && ta.value.includes('REPAIRED_BY_TEST_AGENT');
        },
        { timeout: 5000 }
    );

    const textareaValue = await page.locator('[data-feature-requirements]').inputValue();
    console.log('textarea after Repair:', textareaValue.trim());
    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
