//
// probe-canvas-live-updates.mjs — exercise the canvas's live-update
// behavior through the same surfaces a user and an agent would touch.
//
// Two simulated actors:
//   - User: driven through the actual UI via Playwright (scroll, type,
//     click). Reads its result off the screen.
//   - Agent: writes files directly to the sandboxed workspace's
//     filesystem, the way a real agent's editing tools do. Watches the
//     harness's normal fs.watch path. No fake runtime, no scripted
//     dispatch.
//
// Every assertion is a visible-string check — `document.body.innerText`,
// or the value the user sees in an editable field. The probe never reads
// the wire protocol, an endpoint, a data-* attribute, or the DOM shape, so
// the rendering, the protocol, and where state persists can all change
// without touching this test. Injected canvas modules talk to the workspace
// only through the public canvas context (fetchJson / writeFile /
// onWorkspaceEvent) and render their result as visible text.
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

    // A component renders its content directly in component.html. To drive a
    // live update an agent rewrites the component's component.html with new
    // inner markup; the OS file-watcher sees the write and the component
    // re-renders. `componentPath` is the path attribute used inside the
    // document (e.g. 'components/alpha'); `innerHtml` is the authored markup
    // that lands in the component's surface.
    const agentWriteComponent = (relPath, componentPath, innerHtml) => {
        agentWrite(relPath,
            '<liquidos-component path="' + componentPath + '">\n' +
            '    ' + innerHtml + '\n' +
            '</liquidos-component>\n');
    };

    // --- visible-text assertions ------------------------------------------
    // The only thing a probe is allowed to assert: is the string on screen?
    const onScreen = (p, text) => p.evaluate(t => document.body.innerText.includes(t), text);
    const waitOnScreen = async (p, text, timeout = 5000) => {
        try {
            await p.waitForFunction(t => document.body.innerText.includes(t), text, { timeout });
        } catch {
            throw new Error('never appeared on screen: ' + JSON.stringify(text));
        }
    };
    const waitOffScreen = async (p, text, timeout = 5000) => {
        try {
            await p.waitForFunction(t => !document.body.innerText.includes(t), text, { timeout });
        } catch {
            throw new Error('still on screen: ' + JSON.stringify(text));
        }
    };

    // Switch canvases the way the user does — open the Spaces grid, click a
    // card — and confirm the switch by what shows up on screen, never an
    // internal canvas pointer. `expectVisible` is a string unique to the
    // destination canvas's content.
    const switchCanvasVia = async (p, name, expectVisible) => {
        await p.locator('#canvas-overview-toggle').dispatchEvent('click');
        await p.locator(`.canvas-grid-card[data-canvas="${name}"]`).dispatchEvent('click');
        if (expectVisible) await waitOnScreen(p, expectVisible, 8000);
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
    // The fixture's home canvas shows alpha and gamma. gamma is never
    // rewritten by this probe, so "gamma initial" is the stable sentinel for
    // "the home canvas is on screen"; "delta initial" is the same for /other.
    await waitOnScreen(page, 'gamma initial', 15000);

    // --- scenarios ---------------------------------------------------------

    // Agent rewrites alpha's component.html — does the new text show up?
    await test('agent writes component.html → new text shows', async () => {
        const marker = 'alpha rewritten ' + Date.now();
        agentWriteComponent('home/components/alpha/component.html', 'components/alpha',
            '<p>' + marker + '</p>');
        await waitOnScreen(page, marker, 3000);
        return 'screen shows "' + marker + '"';
    });

    // Writes are spaced TIGHTER than the file-watcher's coalescing window.
    // Intermediate frames may be dropped (the watcher coalesces rapid
    // writes — "every intermediate frame survives" is NOT guaranteed), but
    // the final state must always arrive. This is the canonical
    // "final state arrives after coalescing" guarantee.
    await test('agent writes component.html in a tight burst → final text arrives', async () => {
        const finalMarker = 'burst final ' + Date.now();
        for (let i = 0; i < 5; i++) {
            agentWriteComponent('home/components/alpha/component.html', 'components/alpha',
                '<p>burst step ' + i + '</p>');
            await sleep(10);
        }
        agentWriteComponent('home/components/alpha/component.html', 'components/alpha',
            '<p>' + finalMarker + '</p>');
        await waitOnScreen(page, finalMarker, 3000);
        return 'final text on screen';
    });

    // Agent rewrites canvas.js — verify the browser re-imports it and the new
    // module's output shows up. The new module renders a unique banner string
    // (inside place(), so it survives every re-render); we assert that string
    // is visible.
    await test('agent writes canvas.js → browser re-imports and renders it', async () => {
        const marker = 'canvas banner ' + Date.now();
        agentWrite('home/canvas.js', `
            export default (root) => ({
                place(items) {
                    const banner = document.createElement('div');
                    banner.textContent = ${JSON.stringify(marker)};
                    root.replaceChildren(banner, ...items);
                },
                teardown() { root.replaceChildren(); }
            });
        `);
        await waitOnScreen(page, marker, 5000);
        return 'screen shows "' + marker + '"';
    });

    // canvas.js self-observes a workspace file through the public canvas
    // context — onWorkspaceEvent to learn a file changed, fetchJson to read
    // it — and renders the value as visible text. The agent writes the file;
    // we assert the value appears on screen. This is the path that replaced
    // "the harness passes state to place()": canvas.js owns observation.
    await test('canvas.js observes a workspace file → its value shows on screen', async () => {
        agentWrite('home/canvas.js', `
            export default (root, context) => {
                const { fetchJson, onWorkspaceEvent } = context;
                const banner = document.createElement('div');
                const reflect = async () => {
                    const json = await fetchJson('home/state.json').catch(() => null);
                    if (json && json.probe) banner.textContent = json.probe;
                };
                const off = onWorkspaceEvent(payload => {
                    if (payload && payload.type === 'workspace-file' && payload.path === 'home/state.json') reflect();
                });
                reflect();
                return {
                    place(items) { root.replaceChildren(banner, ...items); },
                    teardown() { if (off) off(); root.replaceChildren(); }
                };
            };
        `);
        // Let the new canvas.js mount and subscribe before the agent writes.
        await sleep(800);
        const marker = 'observed state ' + Date.now();
        agentWrite('home/state.json', { probe: marker });
        await waitOnScreen(page, marker, 5000);
        return 'screen shows "' + marker + '"';
    });

    // A second client (think: a second browser window) must see the active
    // canvas change when the first client switches. The follow happens live,
    // proven by the other canvas's content appearing in the second tab.
    await test('user switches canvas in one tab → other tab follows', async () => {
        const pageB = await browser.newPage();
        pageB.on('pageerror', err => console.warn('[pageerror-B]', err.message));
        await pageB.goto(url, { waitUntil: 'domcontentloaded' });
        // B starts on home — its home content showing also means B has fully
        // mounted (and its live channel is up) before A switches.
        await waitOnScreen(pageB, 'gamma initial', 10000);

        try {
            // Page A drives the change through the grid.
            await switchCanvasVia(page, 'other', 'delta initial');
            // Page B must follow without a reload.
            await waitOnScreen(pageB, 'delta initial', 5000);

            // Restore /home in both tabs for downstream scenarios.
            await switchCanvasVia(page, 'home', 'gamma initial');
            await waitOnScreen(pageB, 'gamma initial', 5000);
            return 'second tab followed the switch';
        } finally {
            await pageB.close();
        }
    });

    // User switches canvas from the grid — the screen swaps to the other
    // canvas's content.
    await test('user switches canvas via grid → other canvas shows', async () => {
        await switchCanvasVia(page, 'other', 'delta initial');
        await waitOffScreen(page, 'gamma initial', 5000);
        // Switch back so the rest of the suite operates on /home.
        await switchCanvasVia(page, 'home', 'gamma initial');
        return 'delta shown, then home restored';
    });

    // The destination canvas must stay rendered even when the source canvas's
    // teardown writes a workspace file mid-switch (a canvas persisting e.g.
    // camera state on the way out, through the public writeFile). That write's
    // broadcast lands after the switch is already in flight — if the harness
    // reacts in a way that races loadCanvas, the destination flashes on screen
    // and then disappears until the user switches away and back.
    await test('source canvas write-on-teardown → destination stays on screen', async () => {
        agentWrite('home/canvas.js', `
            export default (root, context) => {
                const { writeFile, onWorkspaceEvent } = context;
                // Mirror a canvas that observes the workspace and persists on exit.
                const off = onWorkspaceEvent(() => {});
                return {
                    place(items) { root.replaceChildren(...items); },
                    teardown() {
                        if (off) off();
                        writeFile('home/state.json', { ts: 'teardown' });
                        root.replaceChildren();
                    }
                };
            };
        `);
        // Let the new canvas.js mount in /home.
        await waitOnScreen(page, 'gamma initial', 5000);
        // Switch to /other; the destination must stay put well after the
        // teardown write's broadcast has had time to round-trip.
        await switchCanvasVia(page, 'other', 'delta initial');
        await sleep(1500);
        if (!(await onScreen(page, 'delta initial'))) {
            throw new Error('delta disappeared after the source canvas teardown write');
        }
        // Restore a clean home/canvas.js so the rest of the suite runs on the
        // plain fixture (no write-on-teardown side effect lurking).
        agentWrite('home/canvas.js', "import { cssLayout } from '/lib/css-layout.js';\nexport default cssLayout('');");
        await switchCanvasVia(page, 'home', 'gamma initial');
        return 'delta survived the source teardown write';
    });

    // Agent creates a new canvas folder — the Spaces grid should grow to list
    // it (the new name shows when the grid is open).
    await test('agent creates canvas folder → grid lists it', async () => {
        const name = 'probe-canvas-' + Date.now();
        agentWrite(name + '/index.json', { components: [] });
        agentWrite(name + '/canvas.js', "import { cssLayout } from '/lib/css-layout.js'; export default cssLayout('');");
        // Open the grid and look for the new name on screen.
        await page.locator('#canvas-overview-toggle').dispatchEvent('click');
        await waitOnScreen(page, name, 5000);
        // Close the grid (Escape) and confirm we're back on the canvas.
        await page.keyboard.press('Escape');
        await waitOnScreen(page, 'gamma initial', 5000);
        return 'grid lists ' + name;
    });

    // Agent adds a component to index.json — the new component's text should
    // appear. Remembered so the next scenario can remove it and prove it goes.
    let addedMarker = null;
    await test('agent adds component → new component text appears', async () => {
        const newName = 'probe-new-' + Date.now();
        addedMarker = 'added component ' + newName;
        const rel = 'home/components/' + newName;
        agentWriteComponent(rel + '/component.html', 'components/' + newName,
            '<p>' + addedMarker + '</p>');
        const input = JSON.parse(agentRead('home/index.json'));
        input.components.push('components/' + newName + '/component.html');
        agentWrite('home/index.json', input);
        await waitOnScreen(page, addedMarker, 15000);
        return 'screen shows "' + addedMarker + '"';
    });

    // Agent removes that component — its text should disappear.
    await test('agent removes component → its text disappears', async () => {
        // Settle from the previous write before the next one — too-close writes
        // to index.json can coalesce in the watcher and the canvas only sees
        // the second state, missing whatever was added in between.
        await sleep(800);
        const input = JSON.parse(agentRead('home/index.json'));
        input.components.pop();
        agentWrite('home/index.json', input);
        await waitOffScreen(page, addedMarker, 15000);
        return 'removed component text gone';
    });

    // User opens a component's requirements editor by clicking its labelled
    // "Edit Gamma requirements" button — found by accessible name, the way a
    // user (or a screen reader) tells it apart from every other component's
    // Requirements button. The title and requirements text then show. The
    // requirements live in an editable field, so we read the value the user
    // sees in that field. Gamma is used because this probe never rewrites it.
    await test('user opens requirements editor → title + requirements show', async () => {
        await page.getByRole('button', { name: 'Edit Gamma requirements' }).click();
        // The title is rendered text ("Gamma", capitalized — distinct from the
        // component's own "gamma …" body).
        await waitOnScreen(page, 'Gamma', 5000);
        // The requirements field — the only one on screen now that Gamma's
        // editor is open — identified by its visible placeholder.
        const shown = await page.getByPlaceholder(/^Describe what this component/).locator('visible=true').inputValue();
        if (!shown.startsWith('- Gamma')) {
            throw new Error('requirements field shows: ' + JSON.stringify(shown.slice(0, 60)));
        }
        return 'title "Gamma" + requirements bullet visible';
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
