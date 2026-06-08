#!/usr/bin/env node
//
// probe-create-component-scaffolds.mjs
//
// Scaffold a canvas, run skills/component/scripts/create-component.sh,
// boot the workspace, and assert the new component renders in the
// browser. If the scaffold puts files in the wrong place or appends
// the wrong path to input.json, the component never reaches the DOM
// and the probe times out.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
fs.writeFileSync(path.join(canvasDir, 'input.json'), '{ "components": [] }\n');
fs.writeFileSync(path.join(canvasDir, 'canvas.js'), "import { cssLayout } from '/lib/css-layout.js';\nexport default cssLayout('');\n");

// Run the scaffolder.
const scaffold = spawnSync('bash', [createComponent, canvasDir, 'gizmo'], { encoding: 'utf8' });
if (scaffold.status !== 0) {
    console.error('FAIL: create-component.sh exited', scaffold.status);
    console.error('stderr:', scaffold.stderr);
    process.exit(1);
}

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', ws, '--app', appRoot
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

const cleanup = () => {
    try { launcher.kill('SIGTERM'); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });

let exitCode = 0;
try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // The scaffold's initial view.json renders a "Loading…" placeholder
    // titled with the display-cased component name. Asserting both means
    // the component's view.json reached the surface (entry path is right
    // in input.json, component.html composed correctly, view.json
    // rendered) — i.e. the scaffold did everything it needed to.
    await page.waitForFunction(
        () => /Gizmo/.test(document.body.innerText) && /Loading/.test(document.body.innerText),
        { timeout: 15000 }
    );

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error('FAIL:', e.message);
    exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
