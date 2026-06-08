#!/usr/bin/env node
//
// probe-canvas-missing-components.mjs
//
// Canvas's input.json references a component that doesn't have a real
// entry file (the foo7-style case: entries are folder paths from the
// old shape, the new shape needs component.html). The canvas is broken
// from the user's perspective — the user should see the canvas-level
// Repair card (same one probe-canvas-damaged exercises for malformed
// input.json), not a silently empty canvas.

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

    // The user-facing affordance: a visible Repair button on first paint.
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button'))
            .some(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0),
        { timeout: 10000 }
    );

    // And nothing else — no per-file "missing:" noise sitting next to
    // the Repair card, no leftover canvas decoration (e.g. a rain
    // overlay) that the canvas painted before the harness knew it was
    // broken. Either would be confusing noise around the Repair card.
    await new Promise(r => setTimeout(r, 500)); // let any race flicker in
    const noisy = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        return {
            missingHits:          (bodyText.match(/missing:/g) || []).length,
            stillHasLiquidosFile: !!document.querySelector('liquidos-file'),
            canvasOverlayHits:    document.querySelectorAll('[data-canvas-overlay]').length
        };
    });
    if (noisy.missingHits > 0) {
        console.error('FAIL:', noisy.missingHits, '"missing:" text(s) still rendered next to Repair card');
        exitCode = 1;
    }
    if (noisy.stillHasLiquidosFile) {
        console.error('FAIL: <liquidos-file> elements still in DOM after canvas-level error');
        exitCode = 1;
    }
    if (noisy.canvasOverlayHits > 0) {
        console.error('FAIL:', noisy.canvasOverlayHits, 'canvas-overlay element(s) still in DOM after canvas-level error');
        exitCode = 1;
    }

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
