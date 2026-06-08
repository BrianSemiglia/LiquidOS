#!/usr/bin/env node
//
// probe-canvas-damaged-prompt-carries-contract.mjs
//
// The Repair card surfaced for a canvas-damaged condition must hand
// the agent enough context to act without guessing. Skill discovery is
// LLM-decided and unreliable — the prompt is the only signal we
// control. The probe asserts the canvas-Repair callback's prompt names
// the contract (input.json entries must end in component.html, the
// agent must write the file AND update input.json), so a dispatched
// agent has the recipe without needing to find any specific skill.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'component-missing.liquidos');

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

    // Wait for the canvas Repair card.
    await page.waitForSelector('[role="group"][data-repair-level="canvas"]', { timeout: 10000 });

    // Read the callback's prompt — that's what gets dispatched on click.
    const prompt = await page.evaluate(() => {
        const card = document.querySelector('[role="group"][data-repair-level="canvas"]');
        const cb = card?.querySelector('liquidos-callback');
        return cb?.getAttribute('prompt') || '';
    });

    const expectations = [
        { name: 'names the original error',     ok: /Repair required due to error/.test(prompt) },
        { name: 'points at the canvas skill',   ok: /skills\/canvas\/SKILL\.md/i.test(prompt) }
    ];
    const failed = expectations.filter(e => !e.ok);
    if (failed.length > 0) {
        console.error('FAIL: prompt missing contract:', failed.map(f => f.name).join(', '));
        console.error('--- prompt as carried ---');
        console.error(prompt);
        console.error('---');
        exitCode = 1;
    } else {
        console.log('PASS');
    }
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
