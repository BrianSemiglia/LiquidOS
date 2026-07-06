//
// probe-component-redesign-live-reload — a redesigned component must
// repaint on the active canvas without the user leaving and coming back.
//
// The shape that used to break is the keyboard's: a component whose entry
// component.html holds an empty container plus a sibling
// <liquidos-file ... script> that fills it at runtime, with a run-mode
// service.js alongside. When the design skill redesigns it, it writes
// functions.js with its Write tool (a direct disk write) and then rewrites
// component.html through an <lqpatch op="writeFile">, which the client turns
// into PUT /workspace/… — a write the SERVER performs. That write used to
// rely on fs.watch noticing it, and fs.watch drops the server's own writes
// under load, so the redesign could fail to repaint until a canvas switch.
//
// The workspace is now watched by @parcel/watcher, which reports every
// change (the server's own writes included), so both halves of the redesign
// land live. This probe drives the exact two write paths and asserts the new
// design — the caption authored in component.html — shows without a switch.
//
// Run it:  node skills/testing/scripts/run-probe.mjs \
//            skills/testing/scripts/probe-component-redesign-live-reload
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './workspace.liquidos';

export default async ({ url, workspace, page }) => {
    console.log('sandbox url:      ', url);
    console.log('sandbox workspace:', workspace);
    console.log();

    const agentWrite = (relPath, content) => {
        const abs = path.join(workspace, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, typeof content === 'string'
            ? content
            : JSON.stringify(content, null, 2) + '\n');
    };
    const agentRead = relPath => fs.readFileSync(path.join(workspace, relPath), 'utf8');

    // A keyboard-shaped component: empty [data-keys] bed + controls + an
    // `inert` stage in the entry html, a script-mode functions.js that queries
    // every control, builds the keys, then lifts `inert`, and a run-mode
    // service.js sibling. `caption` is the redesign's visible signal and lives
    // in component.html — the file written through lqpatch (PUT).
    const componentHtml = caption =>
        '<liquidos-component path="components/keyboard">\n' +
        '    <section class="kb-panel">\n' +
        '        <h3 class="kb-caption">' + caption + '</h3>\n' +
        '        <div class="kb-controls">\n' +
        '            <span class="kb-oct" data-oct>4</span>\n' +
        '            <button data-down>−</button>\n' +
        '            <button data-up>+</button>\n' +
        '            <input type="range" data-vel min="1" max="127" value="100">\n' +
        '            <span data-velval>100</span>\n' +
        '            <input type="checkbox" data-sustain>\n' +
        '            <input type="checkbox" data-local checked>\n' +
        '            <button data-test>Test</button>\n' +
        '        </div>\n' +
        '        <div class="kb-stage" data-stage inert>\n' +
        '            <div class="kb-keys" data-keys></div>\n' +
        '        </div>\n' +
        '    </section>\n' +
        '    <liquidos-file path="components/keyboard/functions.js" script></liquidos-file>\n' +
        '    <liquidos-file path="components/keyboard/service.js" run></liquidos-file>\n' +
        '</liquidos-component>\n';

    const functionsJs = label =>
        'export const mount = (surface) => {\n' +
        '    const bed = surface.querySelector("[data-keys]");\n' +
        '    if (!bed) return;\n' +
        '    const octEl = surface.querySelector("[data-oct]");\n' +
        '    const velEl = surface.querySelector("[data-vel]");\n' +
        '    const velValEl = surface.querySelector("[data-velval]");\n' +
        '    const sustainEl = surface.querySelector("[data-sustain]");\n' +
        '    const localEl = surface.querySelector("[data-local]");\n' +
        '    const downBtn = surface.querySelector("[data-down]");\n' +
        '    const upBtn = surface.querySelector("[data-up]");\n' +
        '    const testBtn = surface.querySelector("[data-test]");\n' +
        '    const stageEl = surface.querySelector("[data-stage]");\n' +
        '    const build = () => {\n' +
        '        bed.innerHTML = "";\n' +
        '        ["C", "D", "E"].forEach(note => {\n' +
        '            const key = document.createElement("div");\n' +
        '            key.className = "kb-key";\n' +
        '            key.textContent = ' + JSON.stringify(label) + ' + " " + note;\n' +
        '            bed.appendChild(key);\n' +
        '        });\n' +
        '    };\n' +
        '    const onVel = () => { velValEl.textContent = velEl.value; };\n' +
        '    const onDown = () => { octEl.textContent = String(+octEl.textContent - 1); build(); };\n' +
        '    const onUp = () => { octEl.textContent = String(+octEl.textContent + 1); build(); };\n' +
        '    velEl.addEventListener("input", onVel);\n' +
        '    sustainEl.addEventListener("change", () => {});\n' +
        '    localEl.addEventListener("change", () => {});\n' +
        '    downBtn.addEventListener("click", onDown);\n' +
        '    upBtn.addEventListener("click", onUp);\n' +
        '    testBtn.addEventListener("click", () => {});\n' +
        '    velValEl.textContent = velEl.value;\n' +
        '    build();\n' +
        '    stageEl.removeAttribute("inert");\n' +
        '    return () => {\n' +
        '        velEl.removeEventListener("input", onVel);\n' +
        '        downBtn.removeEventListener("click", onDown);\n' +
        '        upBtn.removeEventListener("click", onUp);\n' +
        '    };\n' +
        '};\n';

    // The run service just stays alive — enough to give the component a
    // run-mode <liquidos-file> sibling like the real one.
    const serviceJs =
        '#!/usr/bin/env node\n' +
        'process.stdin.resume();\n' +
        'setInterval(() => {}, 1 << 30);\n';

    const captionOnScreen = (p, text) => p.evaluate(t =>
        Array.from(document.querySelectorAll('main .item .kb-caption'))
            .some(el => el.textContent.includes(t)), text);

    // Each canvas paints its own distinct content, so the target's text landing
    // on screen is the visible proof the switch completed.
    const canvasContent = { home: 'alpha initial', other: 'delta initial' };
    const switchCanvasVia = async (p, name) => {
        await p.getByRole('button', { name: 'Show all spaces' }).dispatchEvent('click');
        await p.getByRole('button', { name: `Open ${name} space` }).dispatchEvent('click');
        await p.waitForFunction(t => visibleText().includes(t), canvasContent[name], { timeout: 8000 });
    };

    await page.setViewportSize({ width: 1280, height: 840 });
    page.on('pageerror', err => console.warn('[pageerror]', err.message));

    // --- seed the keyboard-shaped component, design v1 ---------------------
    agentWrite('home/components/keyboard/service.js', serviceJs);
    fs.chmodSync(path.join(workspace, 'home/components/keyboard/service.js'), 0o755);
    agentWrite('home/components/keyboard/functions.js', functionsJs('V1'));
    agentWrite('home/components/keyboard/component.html', componentHtml('KEYBOARD v1'));
    const input = JSON.parse(agentRead('home/index.json'));
    if (!input.components.includes('components/keyboard/component.html')) {
        input.components.push('components/keyboard/component.html');
    }
    agentWrite('home/index.json', input);

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('main .item').length > 0, { timeout: 15000 });

    const sawV1 = await page.waitForFunction(
        () => Array.from(document.querySelectorAll('main .item .kb-caption'))
            .some(el => el.textContent.includes('KEYBOARD v1')),
        null, { timeout: 8000 }
    ).then(() => true).catch(() => false);
    if (!sawV1) throw new Error('setup: v1 keyboard never painted');
    console.log('setup ok: v1 keyboard on screen');

    // Also wait for the script-built keys, so we know the live mount ran.
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('main .item .kb-key'))
            .some(el => el.textContent.includes('V1 C')),
        null, { timeout: 8000 }
    );

    // --- the redesign, exactly as the design skill applies it --------------
    // functions.js via the Write tool (direct disk), then component.html via
    // lqpatch writeFile (PUT /workspace). No canvas switch.
    agentWrite('home/components/keyboard/functions.js', functionsJs('V2'));
    await page.evaluate(async ({ rel, content }) => {
        await fetch('/workspace/' + rel, {
            method: 'PUT',
            headers: { 'content-type': 'text/plain' },
            body: content
        });
    }, { rel: 'home/components/keyboard/component.html', content: componentHtml('KEYBOARD v2') });

    const sawV2 = await page.waitForFunction(
        () => Array.from(document.querySelectorAll('main .item .kb-caption'))
            .some(el => el.textContent.includes('KEYBOARD v2')),
        null, { timeout: 6000 }
    ).then(() => true).catch(() => false);

    if (!sawV2) {
        // Diagnostic: does the classic workaround (leave the canvas and come
        // back) recover it? If so, the write landed but never repainted live.
        await switchCanvasVia(page, 'other');
        await switchCanvasVia(page, 'home');
        const afterSwitch = await captionOnScreen(page, 'KEYBOARD v2');
        throw new Error(
            'redesigned component.html (KEYBOARD v2) never repainted on the ' +
            'active canvas; recovered after a canvas round-trip: ' + afterSwitch);
    }

    console.log('redesigned component.html repainted without a canvas switch');
    return 'redesign live-reloaded';
};
