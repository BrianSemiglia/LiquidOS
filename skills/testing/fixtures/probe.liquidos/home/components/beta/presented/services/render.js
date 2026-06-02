// Beta's render.js — watches view.html, writes view.json. Mirrors what
// a typical scaffolded component does, kept minimal so the probe can
// exercise the view.html → render.js → view.json pipeline.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const services = path.dirname(fileURLToPath(import.meta.url));
const viewHtmlPath = path.join(services, '..', 'view.html');
const viewJsonPath = path.join(services, '..', 'view.json');

const writeView = () => {
    const html = fs.existsSync(viewHtmlPath) ? fs.readFileSync(viewHtmlPath, 'utf8') : '';
    fs.writeFileSync(viewJsonPath, JSON.stringify({ title: 'Beta', html }, null, 2) + '\n');
};

writeView();
fs.watch(path.dirname(viewHtmlPath), (_event, filename) => {
    if (filename === 'view.html') writeView();
});

setInterval(() => {}, 1 << 30);
