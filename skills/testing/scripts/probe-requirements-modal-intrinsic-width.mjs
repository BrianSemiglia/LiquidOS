#!/usr/bin/env node
//
// probe-requirements-modal-intrinsic-width.mjs
//
// The fixture renders a 200px-wide div as the component's view. When
// the user opens the Requirements modal, the surface — and the front
// face that contains it — should shrink to that intrinsic width, not
// stretch to fill the modal's left column. Stretched surfaces make
// the component look misplaced (Rain Control card sitting alone in a
// 700px-wide grey box).

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'requirements-modal-intrinsic.liquidos');
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-narrow]', { timeout: 15000 });

    // Open the modal.
    await page.locator('[data-component-flip]').first().evaluate(el => el.click());
    await page.waitForFunction(
        () => !!document.querySelector('.requirements-overlay [data-narrow]'),
        { timeout: 5000 }
    );
    await sleep(300);

    const layout = await page.evaluate(() => {
        const overlay = document.querySelector('.requirements-overlay');
        const item    = overlay?.querySelector('.item');
        const front   = overlay?.querySelector('.component-front');
        const back    = overlay?.querySelector('.component-back');
        const widget  = overlay?.querySelector('[data-narrow]');
        return {
            widgetW:    widget ? widget.getBoundingClientRect().width  : -1,
            itemLeft:   item   ? item.getBoundingClientRect().left     : -1,
            itemRight:  item   ? item.getBoundingClientRect().right    : -1,
            frontLeft:  front  ? front.getBoundingClientRect().left    : -1,
            backRight:  back   ? back.getBoundingClientRect().right    : -1
        };
    });
    console.log('layout:', layout);

    if (layout.widgetW !== 200) {
        console.error('FAIL: widget rendered at', layout.widgetW, 'px instead of its intrinsic 200px');
        exitCode = 1;
    }
    // Collectively centered: front + back as a pair sits centered in
    // the modal item. Slack on the left of the front and slack on the
    // right of the back must match.
    const leftSlack  = layout.frontLeft - layout.itemLeft;
    const rightSlack = layout.itemRight - layout.backRight;
    if (Math.abs(leftSlack - rightSlack) > 2) {
        console.error('FAIL: front+back pair is not centered in the modal item — leftSlack=' + leftSlack + ', rightSlack=' + rightSlack);
        exitCode = 1;
    }

    if (!exitCode) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally { cleanup(); process.exit(exitCode); }
