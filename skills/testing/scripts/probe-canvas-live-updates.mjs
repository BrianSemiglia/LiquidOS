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
// Run it:  node run-probe.mjs probe-canvas-live-updates.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = 'probe.liquidos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page, browser }) => {
    console.log('sandbox url:      ', url);
    console.log('sandbox workspace:', workspace);
    console.log();

    // Agent-side: direct filesystem writes. The probe is acting as if it
    // were a real agent's Write tool.
    const agentWrite = (relPath, content) => {
        const abs = path.join(workspace, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
    };

    const agentRead = (relPath) => {
        const abs = path.join(workspace, relPath);
        return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    };

    // view.json-as-a-view is retired: a component renders its content
    // directly in component.html. To drive a live update an agent rewrites
    // the component's component.html with new inner markup; the OS
    // file-watcher sees the write and the component re-renders (morph).
    // `componentPath` is the path attribute used inside the document
    // (e.g. 'components/alpha'); `innerHtml` is the authored markup that
    // lands in the component's .surface.
    const agentWriteComponent = (relPath, componentPath, innerHtml) => {
        agentWrite(relPath,
            '<liquidos-component path="' + componentPath + '">\n' +
            '    ' + innerHtml + '\n' +
            '</liquidos-component>\n');
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

    await page.setViewportSize({ width: 1280, height: 840 });
    page.on('pageerror', err => console.warn('[pageerror]', err.message));

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('main .item').length > 0, { timeout: 15000 });

    // --- scenarios ---------------------------------------------------------

    // Agent rewrites alpha's component.html — does the rendered component
    // DOM pick up the new inner markup? (view.json-as-a-view is retired;
    // component.html is the live-update vehicle.)
    await test('agent writes component.html → surface updates', async () => {
        const probe = 'probe-component-html-' + Date.now();
        agentWriteComponent('home/components/alpha/component.html', 'components/alpha',
            '<p data-probe="' + probe + '">v</p>');
        const hit = await page.waitForFunction(marker =>
            Array.from(document.querySelectorAll('main .item'))
                .some(item => item.querySelector('[data-probe="' + marker + '"]')),
            probe,
            { timeout: 3000 }).then(() => true).catch(() => false);
        if (!hit) throw new Error('component DOM never picked up component.html change');
        return 'rendered DOM has probe marker';
    });

    // Writes are spaced TIGHTER than the file-watcher's coalescing window.
    // Intermediate frames may be dropped (the watcher coalesces rapid
    // writes — "every intermediate frame survives" is NOT guaranteed), but
    // the final state must always arrive. This is the canonical
    // "final state arrives after coalescing" guarantee.
    await test('agent writes component.html in a tight burst → final state arrives', async () => {
        const finalProbe = 'tight-burst-final-' + Date.now();
        for (let i = 0; i < 5; i++) {
            agentWriteComponent('home/components/alpha/component.html', 'components/alpha',
                '<p data-burst="' + i + '">step ' + i + '</p>');
            await sleep(10);
        }
        agentWriteComponent('home/components/alpha/component.html', 'components/alpha',
            '<p data-burst="final" data-final="' + finalProbe + '">final</p>');
        await page.waitForFunction(marker =>
            Array.from(document.querySelectorAll('main .item'))
                .some(item => item.querySelector('[data-final="' + marker + '"]')),
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

    // A second client (think: a second browser window) must see the active
    // canvas change when the first client switches via the dropdown. fs.watch
    // on macOS doesn't reliably fire for the server's own writes, so the
    // /canvas POST has to emit canvases-changed itself — this scenario
    // catches a regression of that fact, from the user's perspective.
    await test('user switches canvas in one tab → other tab follows', async () => {
        // Open a second page on the same workspace. Same sandbox, same server,
        // independent dropdown state.
        const pageB = await browser.newPage();
        pageB.on('pageerror', err => console.warn('[pageerror-B]', err.message));
        await pageB.goto(url, { waitUntil: 'domcontentloaded' });
        await pageB.waitForSelector('#canvas-select', { timeout: 10000 });
        // Both tabs should start on /home (the workspace's active canvas).
        await pageB.waitForFunction(
            () => document.getElementById('canvas-select')?.value === 'home',
            undefined, { timeout: 5000 }
        );
        // Wait for page B's /events SSE to be live before page A switches.
        // Otherwise A's switch can broadcast canvases-changed before B has
        // connected, and B misses the event — the race this probe used to hit.
        await pageB.evaluate(() => new Promise(res => {
            const es = new EventSource('/events');
            es.onopen = () => { es.close(); res(); };
            setTimeout(() => { es.close(); res(); }, 3000);
        }));

        try {
            // Page A drives the change through the dropdown.
            await page.selectOption('#canvas-select', 'other');

            // Page B's dropdown must follow without a reload.
            await pageB.waitForFunction(
                () => document.getElementById('canvas-select')?.value === 'other',
                undefined, { timeout: 5000 }
            );

            // Restore /home in both tabs for downstream scenarios.
            await page.selectOption('#canvas-select', 'home');
            await pageB.waitForFunction(
                () => document.getElementById('canvas-select')?.value === 'home',
                undefined, { timeout: 5000 }
            );
            await page.waitForFunction(() => Array.from(document.querySelectorAll('main .item'))
                .some(item => (item.dataset.componentPath || '').includes('/alpha')), null, { timeout: 5000 });

            return 'second tab followed the switch';
        } finally {
            await pageB.close();
        }
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
        agentWriteComponent(rel + '/component.html', 'components/' + newName,
            '<p data-new="' + newName + '">' + newName + '</p>');
        const input = JSON.parse(agentRead('home/input.json'));
        input.components.push('components/' + newName + '/component.html');
        agentWrite('home/input.json', input);
        const present = await page.waitForFunction(suffix =>
            Array.from(document.querySelectorAll('main .item'))
                .some(item => (item.dataset.componentPath || '').includes('/' + suffix)),
            newName, { timeout: 15000 }
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

    const pass = results.filter(r => r.ok).length;
    console.log();
    console.log(pass + ' / ' + results.length + ' passed');
    for (const r of results) if (!r.ok) console.log('  FAIL ' + r.name + ': ' + r.error);
    if (pass !== results.length) throw new Error(
        (results.length - pass) + ' sub-test(s) failed: ' +
        results.filter(r => !r.ok).map(r => r.name).join(', ')
    );
};
