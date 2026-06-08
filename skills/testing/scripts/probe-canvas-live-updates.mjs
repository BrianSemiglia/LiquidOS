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

// Agent writes view.json N times in rapid succession with each write
// well-separated (>>50ms). The probe records every intermediate state
// the DOM passes through and asserts each one actually shows up.
// This is the progressive-update case: a real agent doing iterative
// edits, the user wanting to watch the component grow.
await test('agent writes view.json progressively → every step reaches the DOM', async () => {
    const seen = new Set();
    await page.exposeFunction('__recordSurface', (innerHtml) => {
        const m = innerHtml.match(/data-progressive="([^"]+)"/);
        if (m) seen.add(m[1]);
    });
    await page.evaluate(() => {
        const observer = new MutationObserver(() => {
            for (const item of document.querySelectorAll('main .item')) {
                const surface = item.querySelector('.surface');
                if (surface) window.__recordSurface(surface.innerHTML);
            }
        });
        observer.observe(document.getElementById('app'), { subtree: true, childList: true, characterData: true });
    });

    const steps = ['one', 'two', 'three', 'four', 'five'];
    for (const step of steps) {
        agentWrite('home/components/alpha/presented/view.json', {
            title: 'Alpha',
            html: '<p data-progressive="' + step + '">' + step + '</p>'
        });
        await sleep(150);  // well above any reasonable debounce
    }
    await sleep(500);  // give the last update time to propagate

    const missed = steps.filter(s => !seen.has(s));
    if (missed.length > 0) {
        throw new Error('missed progressive steps: ' + missed.join(', ') +
            '   (saw: ' + Array.from(seen).join(', ') + ')');
    }
    return 'all ' + steps.length + ' steps observed';
});

// Same scenario but writes are spaced TIGHTER than the server debounce
// (faster than human-perceptible). We expect to lose intermediate steps
// — but the final one must always arrive.
await test('agent writes view.json in a tight burst → final state arrives', async () => {
    const finalProbe = 'tight-burst-final-' + Date.now();
    for (let i = 0; i < 5; i++) {
        agentWrite('home/components/alpha/presented/view.json', {
            title: 'Alpha',
            html: '<p data-burst="' + i + '">step ' + i + '</p>'
        });
        await sleep(10);
    }
    agentWrite('home/components/alpha/presented/view.json', {
        title: 'Alpha',
        html: '<p data-burst="final" data-final="' + finalProbe + '">final</p>'
    });
    await page.waitForFunction(marker =>
        Array.from(document.querySelectorAll('main .item'))
            .some(item => item.querySelector('.surface')?.innerHTML?.includes(marker)),
        finalProbe,
        { timeout: 3000 });
    return 'final state landed';
});

// Agent rewrites canvas.js — verify the browser actually re-imports and
// the new module's effect shows up in the DOM. The probe rewrites
// canvas.js to set a known data attribute on #app during place(); then
// asserts that the attribute is there.
await test('agent writes canvas.js → browser re-imports and re-renders', async () => {
    const probe = 'probe-canvas-js-' + Date.now();
    agentWrite('home/canvas.js', `
        export default () => ({
            place(items, components) {
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

// canvas.js self-observes a workspace file. The probe writes a canvas.js
// that subscribes to /events, filters for workspace-file events naming
// home/state.json, fetches it, and reflects the parsed value to a data
// attribute. Then the agent writes home/state.json and we assert the
// DOM picked it up. This is the path that replaces the old "harness
// passes state to place()" — canvas.js owns observation end to end.
await test('canvas.js observes state.json via /events + /workspace/file', async () => {
    agentWrite('home/canvas.js', `
        export default () => {
            const source = new EventSource('/events');
            const reflect = async () => {
                const response = await fetch('/workspace/home/state.json');
                if (!response.ok) return;
                const json = await response.json();
                const app = document.getElementById('app');
                if (app) app.dataset.state = json.probe || '';
            };
            source.onmessage = event => {
                let payload;
                try { payload = JSON.parse(event.data); } catch { return; }
                if (payload?.type === 'workspace-file' && payload.path === 'home/state.json') {
                    reflect();
                }
            };
            return {
                place(items, components) {
                    document.getElementById('app').replaceChildren(...items);
                },
                teardown() {
                    source.close();
                    const app = document.getElementById('app');
                    if (app) delete app.dataset.state;
                }
            };
        };
    `);
    // Give the new canvas.js a moment to mount and open its EventSource.
    await sleep(800);
    const marker = 'probe-state-' + Date.now();
    agentWrite('home/state.json', { probe: marker });
    const sawState = await page.waitForFunction(
        value => document.getElementById('app')?.dataset?.state === value,
        marker,
        { timeout: 5000 }
    ).then(() => true).catch(() => false);
    if (!sawState) throw new Error('#app[data-state] never reflected ' + marker);
    return '#app[data-state] = ' + marker;
});

// The destination canvas must render its components even when the source
// canvas has async work (a pending fetch) that resolves AFTER teardown
// and tries to manipulate items it captured in its closure during a
// stale place() call from a superseded load(). This was the root cause
// of "switch from gadgets to woof, woof never renders": LOAD-A
// (superseded) would still call the old canvas's place(items, components)
// with the NEW components after losing the loadCanvas race, the old
// canvas would cache them in `lastItems`, and when the old canvas's
// pending fetch resolved (post-teardown) it would call back into
// applyPlacement which yanked the new items out of the DOM into a
// detached subtree.
await test('source canvas with async post-teardown work → destination renders', async () => {
    // Install a "sticky" home canvas that defers a fetch from place()
    // and, when it resolves, wraps each cached item in a div via
    // appendChild — exactly the pattern that breaks. If the harness lets
    // the superseded LOAD-A continue past the supersede signal, the
    // stale place() call captures the destination's items and this
    // post-teardown work moves them out of /other's DOM.
    agentWrite('home/canvas.js', `
        // Replicates gadgets's bug shape: a 'world' div lives inside the
        // canvas root while the canvas is mounted, items are wrapped in
        // children of world, and a pending fetch resolves post-teardown
        // and runs the wrap-and-place logic again. While mounted, world
        // is in app so items stay visible; after teardown world detaches
        // and re-running the placement yanks the cached items into the
        // detached subtree. Without the harness supersede-bail fix, a
        // stale LOAD-A.place() captures the DESTINATION canvas's items
        // into cachedItems, and the post-teardown callback then moves
        // those items out of the destination's DOM.
        export default (root, context) => {
            let cachedItems = [];
            const world = document.createElement('div');
            root.appendChild(world);
            const applyPlacement = () => {
                for (const item of cachedItems) {
                    const wrap = document.createElement('div');
                    wrap.className = 'sticky-wrap';
                    world.appendChild(wrap);
                    wrap.appendChild(item);
                }
            };
            return {
                place(items, components) {
                    cachedItems = items.slice();
                    applyPlacement();
                    fetch('/workspace/home/state.json').finally(applyPlacement);
                },
                teardown() {
                    world.remove();
                }
            };
        };
    `);
    // The sticky canvas wraps each component in a div under a `world` div, so
    // items are no longer direct children of <main> — find them with
    // a deep query.
    await page.waitForFunction(() => Array.from(document.querySelectorAll('section.item'))
        .some(item => (item.dataset.componentPath || '').includes('/alpha')), null, { timeout: 5000 });

    // Switch to /other 10x; the destination must render every time.
    let everFailed = false;
    for (let i = 0; i < 10; i++) {
        await page.selectOption('#canvas-select', 'other');
        const rendered = await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('main .item'))
                .some(item => (item.dataset.componentPath || '').includes('/delta')),
            null, { timeout: 3000 }).then(() => true).catch(() => false);
        if (!rendered) { everFailed = true; break; }
        await page.selectOption('#canvas-select', 'home');
        await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('main .item'))
                .some(item => (item.dataset.componentPath || '').includes('/alpha')),
            null, { timeout: 3000 });
    }
    if (everFailed) throw new Error('destination canvas failed to render across 10 switches');

    // Restore a benign home canvas for subsequent scenarios.
    agentWrite('home/canvas.js', `
        import { cssLayout } from '/lib/css-layout.js';
        export default cssLayout('');
    `);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('main .item'))
        .some(item => (item.dataset.componentPath || '').includes('/alpha')), null, { timeout: 5000 });
    return 'destination rendered 10/10 switches';
});

// A second client (think: a second browser window) listening for
// canvases-changed must see it fire when the canvas is switched via
// the /canvas endpoint. fs.watch on macOS doesn't reliably fire for
// the server's own writes, so /canvas has to emit canvases-changed
// itself — this scenario catches a regression of that fact.
await test('POST /canvas emits canvases-changed for other listeners', async () => {
    const events = [];
    await page.exposeFunction('__sse2', (data) => events.push(data));
    await page.evaluate(() => {
        const src = new EventSource('/events');
        src.onmessage = e => window.__sse2(e.data);
    });
    await sleep(500);  // let the second EventSource subscribe
    events.length = 0;  // drop any startup chatter
    const resp = await page.evaluate(async () => {
        const r = await fetch('/canvas', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'other' })
        });
        return { ok: r.ok, status: r.status };
    });
    if (!resp.ok) throw new Error('POST /canvas failed: ' + resp.status);
    await sleep(1500);
    const sawCanvasesChanged = events.some(d => {
        try { return JSON.parse(d).type === 'canvases-changed'; } catch { return false; }
    });
    if (!sawCanvasesChanged) {
        throw new Error('canvases-changed never fired; events: ' + events.slice(0, 10).join(' | '));
    }
    // Restore /home for downstream scenarios.
    await page.evaluate(async () => {
        await fetch('/canvas', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'home' })
        });
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('main .item'))
        .some(item => (item.dataset.componentPath || '').includes('/alpha')), null, { timeout: 5000 });
    return 'canvases-changed fired';
});


// View pipeline test: a component whose view.html is compiled to
// view.json by a long-running render.js service. The component
// composes the lib elements: <liquidos-file run> launches the
// service, <liquidos-file> renders the service's output. Probes
// whether the agent's edits to view.html propagate through the
// running service to the user's surface — the path most likely to
// silently break.
await test('view.html edit propagates through render.js service to DOM', async () => {
    const name = 'probe-service-' + Date.now();
    const rel = 'home/components/' + name;
    const compAbs = path.join(sandbox.workspace, rel);

    agentWrite(rel + '/feature-requirements.txt', '- Service-driven test component.\n');
    agentWrite(rel + '/view.html', '<p data-probe="seed">seed</p>');
    agentWrite(rel + '/view.json', { title: 'Service Probe', html: '<p data-probe="seed">seed</p>' });
    agentWrite(rel + '/start.sh',
        '#!/usr/bin/env bash\nset -e\ncd "$(dirname "$0")"\nexec node render.js\n');
    agentWrite(rel + '/render.js', `
        import fs from 'node:fs';
        import path from 'node:path';
        import http from 'node:http';
        const here = path.dirname(new URL(import.meta.url).pathname);
        const viewHtml = path.join(here, 'view.html');
        const viewJson = path.join(here, 'view.json');
        const rebuild = () => {
            try {
                const html = fs.readFileSync(viewHtml, 'utf8');
                fs.writeFileSync(viewJson, JSON.stringify({ title: 'Service Probe', html }) + '\\n');
            } catch {}
        };
        rebuild();
        fs.watch(viewHtml, { persistent: false }, () => rebuild());
        http.createServer(() => {}).listen(0);
    `);
    fs.chmodSync(path.join(compAbs, 'start.sh'), 0o755);
    agentWrite(rel + '/component.html',
        '<liquidos-component path="components/' + name + '">\n' +
        '    <liquidos-file path="components/' + name + '/start.sh" run></liquidos-file>\n' +
        '    <liquidos-file path="components/' + name + '/view.json"></liquidos-file>\n' +
        '</liquidos-component>\n');

    const input = JSON.parse(agentRead('home/input.json'));
    input.components.push('components/' + name + '/component.html');
    agentWrite('home/input.json', input);

    await page.waitForFunction(probe =>
        Array.from(document.querySelectorAll('main .item'))
            .some(item => (item.dataset.componentPath || '').includes('/' + probe)),
        name, { timeout: 5000 });

    // Edit view.html — render.js sees the change, writes view.json,
    // the file element morphs in the new content.
    const marker = 'service-edit-' + Date.now();
    agentWrite(rel + '/view.html', '<p data-probe="' + marker + '">edited via view.html</p>');
    const sawEdit = await page.waitForFunction(m =>
        Array.from(document.querySelectorAll('main .item'))
            .some(item => item.querySelector('.surface')?.innerHTML?.includes(m)),
        marker, { timeout: 7000 }
    ).then(() => true).catch(() => false);
    if (!sawEdit) throw new Error('view.html edit never reached the DOM via the render.js service');
    return 'view.html edit propagated through service to DOM';
});

// User switches canvas from the dropdown — DOM swaps to the other
// canvas's components.
await test('user switches canvas via dropdown → DOM shows other canvas', async () => {
    await page.selectOption('#canvas-select', 'other');
    const switched = await page.waitForFunction(
        () => Array.from(document.querySelectorAll('main .item')).some(item =>
            (item.dataset.componentPath || '').includes('/delta')),
        null,
        { timeout: 5000 }
    ).then(() => true).catch(() => false);
    if (!switched) throw new Error('delta from /other canvas never appeared');
    // Switch back so the rest of the suite operates on /home.
    await page.selectOption('#canvas-select', 'home');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('main .item'))
        .some(item => (item.dataset.componentPath || '').includes('/alpha')), null, { timeout: 5000 });
    return 'delta appeared after switch';
});

// The destination canvas must stay rendered even when the source canvas's
// teardown POSTs to /writes mid-switch (the 3d canvas does this
// for its camera state). The write fires a workspace-file SSE event and a
// generic update after the switch is already in flight — if the harness
// reacts to either of those in a way that races with loadCanvas, the
// destination flashes on screen and then disappears until the user
// switches away and back. This scenario mirrors the 3d canvas more
// closely: EventSource open on mount, lazy per-component state fetches,
// async write on teardown.
await test('source canvas write-on-teardown → destination stays rendered', async () => {
    agentWrite('home/canvas.js', `
        export default (root, context) => {
            // Mirror the 3d canvas: open SSE, lazy fetch component state,
            // schedule a write-on-teardown.
            const source = new EventSource('/events');
            const componentStates = new Map();
            const loadComponentState = async (componentPath) => {
                const filePath = 'home/' + componentPath + '/state.json';
                try {
                    const response = await fetch('/workspace/' + filePath);
                    componentStates.set(filePath, response.ok ? await response.json() : null);
                } catch { componentStates.set(filePath, null); }
            };
            source.onmessage = (event) => {
                let payload;
                try { payload = JSON.parse(event.data); } catch { return; }
                if (payload?.type !== 'workspace-file') return;
                if (payload.path && payload.path.startsWith('home/components/')) {
                    fetch('/workspace/' + payload.path).catch(() => {});
                }
            };
            // Initial mount fetch like the 3d canvas does for camera state.
            fetch('/workspace/home/state.json').catch(() => {});
            return {
                place(items, components) {
                    components.forEach(c => {
                        const key = 'home/' + c.componentPath + '/state.json';
                        if (!componentStates.has(key)) loadComponentState(c.componentPath);
                    });
                    root.replaceChildren(...items);
                },
                teardown() {
                    source.close();
                    fetch('/writes', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                            writes: [{ path: 'home/state.json', content: { ts: Date.now() } }]
                        })
                    }).catch(() => {});
                    root.innerHTML = '';
                }
            };
        };
    `);
    // Let the new canvas.js mount in /home.
    await page.waitForFunction(() => Array.from(document.querySelectorAll('main .item'))
        .some(item => (item.dataset.componentPath || '').includes('/alpha')), null, { timeout: 5000 });
    // Switch to /other and check that delta is still on screen 1 second
    // later (long enough for the write's broadcast to round-trip and any
    // racing load() to potentially blank the destination).
    await page.selectOption('#canvas-select', 'other');
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('main .item')).some(item =>
            (item.dataset.componentPath || '').includes('/delta')),
        null,
        { timeout: 5000 }
    );
    await sleep(1500);
    const stillThere = await page.evaluate(() =>
        Array.from(document.querySelectorAll('main .item'))
            .some(item => (item.dataset.componentPath || '').includes('/delta')));
    if (!stillThere) throw new Error('delta disappeared after source canvas teardown wrote');
    // Restore home/canvas.js so the rest of the suite operates on a clean
    // fixture (no write-on-teardown side effect lurking).
    agentWrite('home/canvas.js', `
        import { cssLayout } from '/lib/css-layout.js';
        export default cssLayout('');
    `);
    await page.selectOption('#canvas-select', 'home');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('main .item'))
        .some(item => (item.dataset.componentPath || '').includes('/alpha')), null, { timeout: 5000 });
    return 'delta survived the source teardown write';
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

// Agent adds a component to input.json — new component should appear.
await test('agent adds component → new component appears in DOM', async () => {
    const newName = 'probe-new-' + Date.now();
    const rel = 'home/components/' + newName;
    agentWrite(rel + '/view.json', { title: 'New', html: '<p data-new="' + newName + '">' + newName + '</p>' });
    agentWrite(rel + '/component.html',
        '<liquidos-component path="components/' + newName + '">\n' +
        '    <liquidos-file path="components/' + newName + '/view.json"></liquidos-file>\n' +
        '</liquidos-component>\n');
    const input = JSON.parse(agentRead('home/input.json'));
    input.components.push('components/' + newName + '/component.html');
    agentWrite('home/input.json', input);
    const present = await page.waitForFunction(suffix =>
        Array.from(document.querySelectorAll('main .item'))
            .some(item => (item.dataset.componentPath || '').includes('/' + suffix)),
        newName, { timeout: 5000 }
    ).then(() => true).catch(() => false);
    if (!present) throw new Error('new component not in DOM after input.json append');
    return 'component present: ' + newName;
});

// Agent removes a component — component should disappear.
await test('agent removes component → component disappears from DOM', async () => {
    // Settle from the previous test's write before the next one — too-close
    // writes to input.json can coalesce in the watcher and the canvas only
    // sees the second state, missing whatever was added in between.
    await sleep(400);
    const input = JSON.parse(agentRead('home/input.json'));
    const dropped = input.components.pop();
    const droppedName = path.basename(path.dirname(dropped));
    agentWrite('home/input.json', input);
    const gone = await page.waitForFunction(suffix =>
        !Array.from(document.querySelectorAll('main .item'))
            .some(item => (item.dataset.componentPath || '').includes('/' + suffix)),
        droppedName, { timeout: 5000 }
    ).then(() => true).catch(() => false);
    if (!gone) throw new Error('component with /' + droppedName + ' still present');
    return 'component removed: ' + droppedName;
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
