#!/usr/bin/env node
//
// probe-canvas-live-updates.mjs — exercise the canvas's live-update
// behavior through the same surfaces a user and an agent would touch.
//
// Two simulated actors:
//   - User: driven through the actual UI via Playwright (scroll, type,
//     click). Reads its own state from the DOM.
//   - Agent: writes files directly to the sandboxed workspace's
//     filesystem, the way a real agent's editing tools do. Watches the
//     harness's normal fs.watch path. No fake runtime, no scripted
//     dispatch.
//
// The probe tests the *app*, not any particular workspace — it uses the
// bundled fixture at fixtures/probe.liquidos. No user-side configuration.
//
// Usage:
//   node skills/testing/scripts/probe-canvas-live-updates.mjs
//

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');           // skills/testing/scripts → repo root
const fixture = path.join(scriptsDir, '..', 'fixtures', 'probe.liquidos');

// --- boot the sandbox --------------------------------------------------

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

console.log('sandbox url:      ', sandbox.url);
console.log('sandbox workspace:', sandbox.workspace);
console.log();

// --- shared helpers ----------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Agent-side: direct filesystem writes. The probe is acting as if it
// were a real agent's Write tool.
const agentWrite = (relPath, content) => {
    const abs = path.join(sandbox.workspace, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};

const agentRead = (relPath) => {
    const abs = path.join(sandbox.workspace, relPath);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};

const results = [];
const test = async (name, fn) => {
    process.stdout.write('▸ ' + name + ' ... ');
    try {
        const detail = await fn();
        results.push({ name, ok: true });
        console.log('OK', detail ? '— ' + detail : '');
    } catch (error) {
        results.push({ name, ok: false, error: error.message });
        console.log('FAIL');
        console.log('   ', error.message);
    }
};

// --- open the actual UI ------------------------------------------------

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 840 } })).newPage();
page.on('pageerror', err => console.warn('[pageerror]', err.message));

await page.goto(sandbox.url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('main .item').length > 0, { timeout: 15000 });

// --- scenarios ---------------------------------------------------------

// Agent writes view.json — does the surface DOM pick up the new html?
await test('agent writes view.json → surface updates', async () => {
    const probe = 'probe-view-json-' + Date.now();
    agentWrite('home/components/alpha/presented/view.json', { title: 'Alpha', html: '<p data-probe="' + probe + '">v</p>' });
    await sleep(800);
    const hit = await page.evaluate(marker =>
        Array.from(document.querySelectorAll('main .item'))
            .some(item => item.querySelector('.surface')?.innerHTML?.includes(marker)),
        probe);
    if (!hit) throw new Error('surface never picked up view.json change');
    return 'surface has probe marker';
});

// Agent rewrites canvas.js — verify the browser actually re-imports and
// the new module's effect shows up in the DOM. The probe rewrites
// canvas.js to set a known data attribute on #app during place(); then
// asserts that the attribute is there.
await test('agent writes canvas.js → browser re-imports and re-renders', async () => {
    const probe = 'probe-canvas-js-' + Date.now();
    agentWrite('home/canvas.js', `
        export default () => ({
            place(items, components, state) {
                const app = document.getElementById('app');
                app.replaceChildren(...items);
                app.dataset.canvasProbe = ${JSON.stringify(probe)};
            },
            teardown() {
                const app = document.getElementById('app');
                if (app) delete app.dataset.canvasProbe;
            }
        });
    `);
    const sawProbe = await page.waitForFunction(
        marker => document.getElementById('app')?.dataset?.canvasProbe === marker,
        probe,
        { timeout: 5000 }
    ).then(() => true).catch(() => false);
    if (!sawProbe) throw new Error('#app never picked up data-canvas-probe = ' + probe);
    return '#app[data-canvas-probe] = ' + probe;
});

// User switches canvas from the dropdown — DOM swaps to the other
// canvas's components.
await test('user switches canvas via dropdown → DOM shows other canvas', async () => {
    await page.selectOption('#canvas-select', 'other');
    const switched = await page.waitForFunction(
        () => Array.from(document.querySelectorAll('main .item')).some(item =>
            item.dataset.componentPath?.endsWith('/delta')),
        null,
        { timeout: 5000 }
    ).then(() => true).catch(() => false);
    if (!switched) throw new Error('delta from /other canvas never appeared');
    // Switch back so the rest of the suite operates on /home.
    await page.selectOption('#canvas-select', 'home');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('main .item'))
        .some(item => item.dataset.componentPath?.endsWith('/alpha')), null, { timeout: 5000 });
    return 'delta appeared after switch';
});

// Agent creates a new canvas folder — the dropdown should grow to
// include it.
await test('agent creates canvas folder → dropdown lists it', async () => {
    const name = 'probe-canvas-' + Date.now();
    agentWrite(name + '/input.json', { components: [] });
    agentWrite(name + '/canvas.js', "import { cssLayout } from '/lib/css-layout.js'; export default cssLayout('');");
    const present = await page.waitForFunction(
        value => Array.from(document.querySelector('#canvas-select')?.options || [])
            .some(opt => opt.value === value),
        name,
        { timeout: 5000 }
    ).then(() => true).catch(() => false);
    if (!present) throw new Error('canvas-select did not gain option ' + name);
    return 'option present: ' + name;
});

// Agent adds a component to input.json — new card should appear.
await test('agent adds component → new card appears in DOM', async () => {
    const newName = 'probe-new-' + Date.now();
    agentWrite('home/components/' + newName + '/presented/view.json', { title: 'New', html: '<p>' + newName + '</p>' });
    const input = JSON.parse(agentRead('home/input.json'));
    input.components.push('components/' + newName);
    agentWrite('home/input.json', input);
    await sleep(1200);
    const present = await page.evaluate(suffix =>
        Array.from(document.querySelectorAll('main .item'))
            .some(item => item.dataset.componentPath?.endsWith('/' + suffix)),
        newName);
    if (!present) throw new Error('new card not in DOM after input.json append');
    return 'card present: ' + newName;
});

// Agent removes a component — card should disappear.
await test('agent removes component → card disappears from DOM', async () => {
    const input = JSON.parse(agentRead('home/input.json'));
    const droppedName = path.basename(input.components.pop());
    agentWrite('home/input.json', input);
    await sleep(1200);
    const still = await page.evaluate(suffix =>
        Array.from(document.querySelectorAll('main .item'))
            .some(item => item.dataset.componentPath?.endsWith('/' + suffix)),
        droppedName);
    if (still) throw new Error('card with /' + droppedName + ' still present');
    return 'card removed: ' + droppedName;
});

// User opens the requirements modal via the flip button — title and
// existing text should populate. The fetch is async, so wait for the
// title to appear instead of guessing a duration.
await test('user opens requirements modal → title + text populate', async () => {
    await page.evaluate(() => {
        document.querySelector('.item[data-component-path$="/alpha"] [data-component-flip]')?.click();
    });
    const populated = await page.waitForFunction(() => {
        const titleEl = document.querySelector('.item[data-component-path$="/alpha"] [data-feature-title]');
        return titleEl && titleEl.textContent && titleEl.textContent.length > 0;
    }, { timeout: 5000 }).then(() => true).catch(() => false);
    if (!populated) throw new Error('title element never populated');

    const view = await page.evaluate(() => ({
        title: document.querySelector('.item[data-component-path$="/alpha"] [data-feature-title]')?.textContent || null,
        text: document.querySelector('.item[data-component-path$="/alpha"] [data-feature-requirements]')?.value || null
    }));
    if (view.title !== 'Alpha') throw new Error('title = ' + JSON.stringify(view.title));
    if (!view.text?.startsWith('- Alpha')) throw new Error('text = ' + JSON.stringify(view.text?.slice(0, 60)));
    return 'title="Alpha", text starts with bullet';
});

// --- finalize ----------------------------------------------------------

await browser.close();
launcher.kill('SIGTERM');

const pass = results.filter(r => r.ok).length;
console.log();
console.log(pass + ' / ' + results.length + ' passed');
for (const r of results) if (!r.ok) console.log('  FAIL ' + r.name + ': ' + r.error);
process.exit(pass === results.length ? 0 : 1);
