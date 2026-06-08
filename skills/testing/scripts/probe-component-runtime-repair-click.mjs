#!/usr/bin/env node
//
// probe-component-runtime-repair-click.mjs
//
// Clicking the runtime Repair button on a component whose functions.js
// has thrown dispatches the agent scoped to that component. The stub
// agent rewrites functions.js to a clean mount and rewrites view.json
// with a known DOM marker. The probe asserts the marker appears AND
// the runtime Repair button disappears — proof that clicking it drove
// the component back to a healthy state.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'component-runtime-error.liquidos');

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture, '--app', appRoot, '--agent', 'component-runtime-repair-test'
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

    // Wait for the runtime Repair button to surface (component has thrown).
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button'))
            .some(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0),
        { timeout: 15000 }
    );

    // Click it.
    await page.locator('button', { hasText: 'Repair' }).first().click();

    // Agent dispatches → either the success marker appears, or the
    // failure marker surfaces the actual prompt the agent received.
    await page.waitForFunction(
        () => document.querySelector('[data-runtime-repair-marker]')
            || document.querySelector('[data-runtime-repair-failure]'),
        { timeout: 10000 }
    );
    const failure = await page.evaluate(() => {
        const el = document.querySelector('[data-runtime-repair-failure]');
        if (!el) return null;
        return {
            reason: el.querySelector('p')?.textContent || '(no reason)',
            promptReceived: el.querySelector('[data-prompt-received]')?.textContent || '(empty)'
        };
    });
    if (failure) {
        console.error('FAIL:', failure.reason);
        console.error('--- prompt the agent received ---');
        console.error(failure.promptReceived);
        console.error('---');
        exitCode = 1;
    } else {
        // On success, the runtime Repair button must also disappear.
        await page.waitForFunction(
            () => !Array.from(document.querySelectorAll('button'))
                .some(b => (b.textContent || '').trim() === 'Repair'
                    && b.getBoundingClientRect().width > 0),
            { timeout: 10000 }
        );
        console.log('PASS');
    }
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
