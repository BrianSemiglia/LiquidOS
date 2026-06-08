#!/usr/bin/env node
//
// probe-create-component-scaffolds-new-shape.mjs
//
// skills/component/scripts/create-component.sh must scaffold a
// new-shape component: every source file lives at the component
// folder root, the input.json entry is the component.html path, and
// no presented/ wrapper directory is produced. Without that, agents
// using the scaffold produce broken components the harness can't load
// (input.json points at a folder that has no component.html).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const scaffold = path.join(appRoot, 'skills/component/scripts/create-component.sh');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-create-component-'));
const canvasDir = path.join(tmp, 'home');
fs.mkdirSync(canvasDir, { recursive: true });
fs.writeFileSync(path.join(canvasDir, 'input.json'), '{ "components": [] }\n');
fs.writeFileSync(path.join(canvasDir, 'canvas.js'), "import { cssLayout } from '/lib/css-layout.js';\nexport default cssLayout('');\n");

const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

let exitCode = 0;
const fail = (msg) => { console.error('FAIL:', msg); exitCode = 1; };

const result = spawnSync('bash', [scaffold, canvasDir, 'gizmo'], { encoding: 'utf8' });
if (result.status !== 0) {
    console.error('FAIL: create-component.sh exited', result.status);
    console.error('stderr:', result.stderr);
    process.exit(1);
}

const componentDir = path.join(canvasDir, 'components', 'gizmo');

// New-shape files at the component root.
const expectedAtRoot = ['component.html', 'feature-requirements.txt', 'view.json', 'functions.js', 'start.sh'];
for (const file of expectedAtRoot) {
    const full = path.join(componentDir, file);
    if (!fs.existsSync(full)) fail(file + ' missing at component root: ' + full);
}

// component.html must wrap content in <liquidos-component path="components/gizmo">.
if (fs.existsSync(path.join(componentDir, 'component.html'))) {
    const html = fs.readFileSync(path.join(componentDir, 'component.html'), 'utf8');
    if (!/<liquidos-component\b[^>]*\bpath="components\/gizmo"/.test(html)) {
        fail('component.html does not declare <liquidos-component path="components/gizmo">');
    }
    if (!/<liquidos-file\b/.test(html)) {
        fail('component.html does not declare any <liquidos-file> children');
    }
}

// start.sh must be executable.
if (fs.existsSync(path.join(componentDir, 'start.sh'))) {
    const mode = fs.statSync(path.join(componentDir, 'start.sh')).mode;
    if (!(mode & 0o111)) fail('start.sh is not executable');
}

// No presented/ wrapper.
if (fs.existsSync(path.join(componentDir, 'presented'))) {
    fail('legacy presented/ directory present at ' + path.join(componentDir, 'presented'));
}

// input.json must reference the .html entry.
const input = JSON.parse(fs.readFileSync(path.join(canvasDir, 'input.json'), 'utf8'));
const wanted = 'components/gizmo/component.html';
if (!Array.isArray(input.components) || !input.components.includes(wanted)) {
    fail('input.json missing "' + wanted + '" — got: ' + JSON.stringify(input.components));
}

if (!exitCode) console.log('PASS');
process.exit(exitCode);
