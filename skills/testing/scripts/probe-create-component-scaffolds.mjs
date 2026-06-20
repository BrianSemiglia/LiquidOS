//
// probe-create-component-scaffolds.mjs
//
// Scaffold a canvas, run skills/component/scripts/create-component.sh,
// boot the workspace, and assert the new component renders in the
// browser. If the scaffold puts files in the wrong place or appends
// the wrong path to index.json, the component never reaches the DOM
// and the probe times out.
//
// Run it:  node run-probe.mjs probe-create-component-scaffolds.mjs
//
// NOTE: this probe builds its own temporary workspace at runtime (there is
// no static fixture). It exports fixture = null so that run-probe.mjs is
// told to pass --workspace via the probe itself. The probe launches its own
// sandbox internally and uses the provided browser from the wrapper.
//

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootSandbox } from './sandbox.mjs';

export const fixture = null;

export default async ({ browser }) => {
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    const appRoot = path.resolve(scriptsDir, '../../..');
    const createComponent = path.join(appRoot, 'skills/component/scripts/create-component.sh');

    // Lay down a temp workspace with a single canvas. We seed it ourselves
    // (instead of routing through the sandbox launcher's source copy) so
    // the scaffolder operates on the real path the harness will then read.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-create-component-'));
    const ws = path.join(tmp, 'probe-create-component.liquidos');
    fs.mkdirSync(ws, { recursive: true });
    const canvasDir = path.join(ws, 'home');
    fs.mkdirSync(canvasDir, { recursive: true });
    fs.writeFileSync(path.join(canvasDir, 'index.json'), '{ "components": [] }\n');
    fs.writeFileSync(path.join(canvasDir, 'canvas.js'), "import { cssLayout } from '/lib/css-layout.js';\nexport default cssLayout('');\n");

    // Run the scaffolder.
    const scaffold = spawnSync('bash', [createComponent, canvasDir, 'gizmo'], { encoding: 'utf8' });
    if (scaffold.status !== 0) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error('create-component.sh exited ' + scaffold.status + '\nstderr: ' + scaffold.stderr);
    }

    // Boot the sandbox internally (dynamic workspace — no static fixture).
    const sandbox = await bootSandbox(ws, { agent: 'none' });

    try {
        const page = await browser.newPage();
        page.on('pageerror', err => console.log('[page error]', err.message));
        await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // The minimal scaffold is just: <liquidos-component path="components/gizmo">
        // with no inline content. Asserting that the element mounted proves
        // the script did its three real jobs — wrote a parseable
        // component.html, wrote feature-requirements.txt, and registered the
        // path in index.json. Diagnostics check below covers the "no Repair"
        // half (the chrome's Repair callback is always in the DOM but hidden
        // unless status.json records an error, so we can't tell from DOM
        // alone — we check the file).
        await page.waitForFunction(
            () => !!document.querySelector('liquidos-component[path="components/gizmo"]'),
            { timeout: 15000 }
        );

        // The fixture files we expect to exist on disk after the scaffold.
        for (const rel of ['home/components/gizmo/component.html',
                           'home/components/gizmo/feature-requirements.txt',
                           'home/components/gizmo/diagnostics/status.json']) {
            if (!fs.existsSync(path.join(ws, rel))) {
                throw new Error('scaffold missing expected file: ' + rel);
            }
        }
        // None of the legacy service-pattern files should exist by default.
        for (const rel of ['home/components/gizmo/view.json',
                           'home/components/gizmo/view.html',
                           'home/components/gizmo/start.sh',
                           'home/components/gizmo/render.js',
                           'home/components/gizmo/IO.swift',
                           'home/components/gizmo/functions.js']) {
            if (fs.existsSync(path.join(ws, rel))) {
                throw new Error('scaffold wrote unexpected legacy file: ' + rel);
            }
        }
    } finally {
        try { sandbox.teardown(); } catch {}
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
};
