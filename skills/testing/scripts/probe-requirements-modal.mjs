#!/usr/bin/env node
//
// probe-requirements-modal.mjs
//
// Verifies the requirements modal:
//   1. Opens with the live component visible AND the requirements editor
//      visible side-by-side, both inside an overlay attached to body.
//   2. Survives a workspace-file event (state-driven canvas re-place). The
//      fixture's canvas.js caches lastItems and re-places on every SSE
//      workspace-file event — exactly the gadgets 3D canvas pattern. If
//      the harness lets the canvas's cached lastItems still reference the
//      real item, the canvas yanks it back into its tree and strands the
//      overlay on body with no .item inside (the user-reported bug).
//   3. Survives a view.json change on the modal'd component (the file-edit
//      race that triggers mountComponentFunctions during render).
//   4. ESC closes — overlay gone, placeholder gone, item returned to #app.
//

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'requirements-modal.liquidos');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture,
    '--app', appRoot,
    '--agent', 'none'
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sandbox = await new Promise((resolve, reject) => {
    let buf = '';
    const onExit = () => reject(new Error('sandbox exited before printing url'));
    launcher.on('exit', onExit);
    launcher.stdout.on('data', chunk => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
            launcher.off('exit', onExit);
            try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
        }
    });
    launcher.stderr.on('data', c => process.stderr.write('[launcher] ' + c.toString('utf8')));
});

console.log('sandbox url:', sandbox.url);
console.log('sandbox workspace:', sandbox.workspace);

const cleanup = () => { try { launcher.kill('SIGTERM'); } catch {} };
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let exitCode = 0;
const fail = msg => { console.error('FAIL:', msg); exitCode = 1; };

const snapshot = page => page.evaluate(() => {
    const overlay = document.querySelector('.requirements-overlay');
    const placeholder = document.querySelector('.requirements-placeholder');
    const item = overlay?.querySelector('.item');
    const meas = el => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return { w: r.width, h: r.height, display: s.display, visibility: s.visibility, opacity: s.opacity };
    };
    return {
        overlayOnBody: !!(overlay && overlay.parentElement === document.body),
        overlayHasItem: !!item,
        placeholderInApp: !!(placeholder && placeholder.closest('#app')),
        front: meas(item?.querySelector('.component-front')),
        back: meas(item?.querySelector('.component-back')),
        textarea: meas(item?.querySelector('[data-feature-requirements]')),
        surface: meas(item?.querySelector('.surface'))
    };
});

const isVisible = m => m && m.display !== 'none' && m.visibility !== 'hidden' && +m.opacity > 0.1 && m.w > 0 && m.h > 0;

try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.item[data-component-path*="widget"]', { timeout: 20000 });
    await sleep(800);

    // --- 1. Open the modal ---
    await page.locator('.item[data-component-path*="widget"] [data-component-flip]')
        .first().evaluate(el => el.click());
    await sleep(500);
    const opened = await snapshot(page);
    console.log('after open:', opened);
    if (!opened.overlayOnBody)    fail('overlay not attached to body');
    if (!opened.overlayHasItem)   fail('overlay has no .item inside');
    if (!opened.placeholderInApp) fail('placeholder not in #app');
    if (!isVisible(opened.front))    fail('component-front not visible: ' + JSON.stringify(opened.front));
    if (!isVisible(opened.back))     fail('component-back not visible: ' + JSON.stringify(opened.back));
    if (!isVisible(opened.surface))  fail('surface not visible: ' + JSON.stringify(opened.surface));
    if (!isVisible(opened.textarea)) fail('requirements textarea not visible: ' + JSON.stringify(opened.textarea));

    // --- 1b. Requirements input behavior: Loading clears after fetch, and
    //         the recover button label depends on the file's state — Repair
    //         when missing/corrupt, Generate when present-but-empty. The
    //         widget fixture has no requirements file, so this iteration
    //         expects Repair.
    await page.waitForFunction(
        () => {
            const loading = document.querySelector('.requirements-overlay [data-feature-loading]');
            return loading && loading.hidden === true;
        },
        { timeout: 5000 }
    ).catch(() => fail('component Loading… did not hide after fetch'));
    let componentRecoverVisible = await page.evaluate(() => {
        const cb = document.querySelector('.requirements-overlay [data-feature-recover-callback]');
        return cb && !cb.hidden;
    });
    if (!componentRecoverVisible) fail('component recover callback did not surface for missing requirements');
    let componentRecoverText = await page.evaluate(() => {
        const btn = document.querySelector('.requirements-overlay [data-feature-recover]');
        return btn ? (btn.textContent || '').trim() : '';
    });
    if (componentRecoverText !== 'Repair') {
        fail('component recover button text is "' + componentRecoverText + '", expected "Repair" (file missing)');
    }
    // --- 1c. Now create an empty requirements file and reopen the
    //         modal. Same UI surface, but the label flips to Generate
    //         because the file is present-but-empty (different repair
    //         path: write from implementation, not find/restore).
    const featurePath = path.join(sandbox.workspace, 'home/components/widget/feature-requirements.txt');
    fs.mkdirSync(path.dirname(featurePath), { recursive: true });
    fs.writeFileSync(featurePath, '');
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.locator('.item[data-component-path*="widget"] [data-component-flip]')
        .first().evaluate(el => el.click());
    await page.waitForFunction(
        () => {
            const cb = document.querySelector('.requirements-overlay [data-feature-recover-callback]');
            return cb && !cb.hidden;
        },
        { timeout: 5000 }
    );
    componentRecoverText = await page.evaluate(() => {
        const btn = document.querySelector('.requirements-overlay [data-feature-recover]');
        return btn ? (btn.textContent || '').trim() : '';
    });
    if (componentRecoverText !== 'Generate') {
        fail('component recover button text is "' + componentRecoverText + '", expected "Generate" (file present but empty)');
    }
    // Restore the missing case for the remainder of the test (preserves the
    // original scenarios that test overlay survival under canvas state churn).
    fs.unlinkSync(featurePath);

    // --- 2. State-driven re-place via workspace-file SSE ---
    //     The fixture's canvas.js subscribes to workspace-file events and
    //     re-places using its cached lastItems. If lastItems still holds
    //     the real item (not the placeholder), the canvas yanks the item
    //     out of the overlay — the stranded-blur bug.
    const stateJson = path.join(sandbox.workspace, 'home/components/widget/state.json');
    fs.writeFileSync(stateJson, JSON.stringify({ tick: 1 }));
    await sleep(800);
    const afterState = await snapshot(page);
    console.log('after state-driven re-place:', afterState);
    if (!afterState.overlayHasItem) fail('STATE-UPDATE BUG: item escaped the overlay during canvas re-place');
    if (!afterState.placeholderInApp) fail('placeholder lost during canvas re-place');

    // --- 3. view.json change on the modal'd component ---
    //     Triggers updateComponentItem → mountComponentFunctions →
    //     destroyComponentFunctions in the render path. The fix moved the
    //     modal-close out of destroyComponentFunctions so a benign re-mount
    //     no longer closes the modal.
    const viewJson = path.join(sandbox.workspace, 'home/components/widget/presented/view.json');
    const json = JSON.parse(fs.readFileSync(viewJson, 'utf8'));
    json.html = (json.html || '') + '<!-- race ' + Date.now() + ' -->';
    fs.writeFileSync(viewJson, JSON.stringify(json, null, 2) + '\n');
    await sleep(1500);
    const afterEdit = await snapshot(page);
    console.log('after view.json edit:', afterEdit);
    if (!afterEdit.overlayHasItem) fail('VIEW-EDIT BUG: item escaped the overlay during component re-mount');
    if (!afterEdit.placeholderInApp) fail('placeholder lost during component re-mount');

    // --- 4. ESC closes cleanly ---
    await page.keyboard.press('Escape');
    await sleep(300);
    const closed = await page.evaluate(() => ({
        overlayGone: !document.querySelector('.requirements-overlay'),
        placeholderGone: !document.querySelector('.requirements-placeholder'),
        itemBackInApp: !!document.querySelector('#app .item[data-component-path*="widget"]')
    }));
    console.log('after ESC:', closed);
    if (!closed.overlayGone)     fail('overlay still on body after ESC');
    if (!closed.placeholderGone) fail('placeholder still in #app after ESC');
    if (!closed.itemBackInApp)   fail('item did not return to #app after ESC');

    // --- 5. Canvas requirements modal mirrors the same input behavior.
    //         Startup bootstrap no longer materializes an empty
    //         feature-requirements.txt — only canvas creation does. So the
    //         fixture's home canvas starts with the file missing → Repair.
    //         Write an empty file to flip to Generate.
    const canvasFeaturePath = path.join(sandbox.workspace, 'home/feature-requirements.txt');
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForSelector('#canvas-requirements-textarea', { state: 'visible', timeout: 5000 });
    await page.waitForFunction(
        () => {
            const loading = document.getElementById('canvas-requirements-loading');
            return loading && loading.hidden === true;
        },
        { timeout: 5000 }
    ).catch(() => fail('canvas Loading… did not hide after fetch'));
    const canvasRecoverVisible = await page.evaluate(() => {
        const cb = document.getElementById('canvas-requirements-recover-callback');
        return cb && !cb.hidden;
    });
    if (!canvasRecoverVisible) fail('canvas recover callback did not surface for missing requirements');
    let canvasRecoverText = await page.evaluate(() => {
        const btn = document.querySelector('#canvas-requirements-recover-callback button');
        return btn ? (btn.textContent || '').trim() : '';
    });
    if (canvasRecoverText !== 'Repair') {
        fail('canvas recover button text is "' + canvasRecoverText + '", expected "Repair" (file missing)');
    }
    fs.writeFileSync(canvasFeaturePath, '');
    await page.locator('#canvas-requirements-cancel').dispatchEvent('click');
    await sleep(300);
    await page.locator('#canvas-info').dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const cb = document.getElementById('canvas-requirements-recover-callback');
            return cb && !cb.hidden;
        },
        { timeout: 5000 }
    );
    canvasRecoverText = await page.evaluate(() => {
        const btn = document.querySelector('#canvas-requirements-recover-callback button');
        return btn ? (btn.textContent || '').trim() : '';
    });
    if (canvasRecoverText !== 'Generate') {
        fail('canvas recover button text is "' + canvasRecoverText + '", expected "Generate" (file present but empty)');
    }
    fs.unlinkSync(canvasFeaturePath);

    if (exitCode === 0) console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('THREW:', e.message);
    if (!exitCode) exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
