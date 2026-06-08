#!/usr/bin/env node
//
// probe-canvas-recover-hidden-on-clear.mjs
//
// Companion to probe-canvas-generate-gates. The fixture has a
// populated feature-requirements.txt and zero components. When the
// user opens the modal and deletes all the text, the textarea ends up
// empty — but there are still no components to write about, so the
// Generate/Repair callback must stay hidden. The gate fires on
// "textarea empty AND zero components", independent of whether the
// file's loaded outcome was 'empty' or 'present'.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'canvas-with-reqs-no-components.liquidos');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture, '--app', appRoot
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

    await page.locator('#canvas-info').click();
    await page.waitForSelector('#canvas-requirements-overlay:not([hidden])', { timeout: 5000 });
    // File loaded with content — wait for the textarea to show it.
    await page.waitForFunction(
        () => document.getElementById('canvas-requirements-textarea')?.value?.includes('Existing requirements'),
        { timeout: 5000 }
    );

    // Clear it.
    await page.locator('#canvas-requirements-textarea').fill('');

    // Recover callback must stay hidden — zero components, nothing to write.
    await sleep(300);
    const visible = await page.evaluate(() => {
        const cb = document.getElementById('canvas-requirements-recover-callback');
        return !!cb && !cb.hidden;
    });
    if (visible) {
        console.error('FAIL: recover callback visible after the user cleared the textarea on a zero-component canvas');
        exitCode = 1;
    } else {
        console.log('PASS');
    }
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
