#!/usr/bin/env node
// Build-time only. Produces go-server/clientdist/ (index.html + the lib/ modules
// the browser fetches from ROOT), which go-server embeds and serves.

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'go-server', 'clientdist');

const ASSETS = [
  'index.html',
  'lib/css-layout.js',
  'lib/liquidos-elements/index.js',
  'lib/liquidos-elements/callback.js',
  'lib/liquidos-elements/component.js',
  'lib/liquidos-elements/file.js',
  'lib/liquidos-elements/error-router.js',
];

function main() {
  if (fs.existsSync(OUT)) {
    for (const name of fs.readdirSync(OUT)) {
      if (name === 'PLACEHOLDER') continue;
      fs.rmSync(path.join(OUT, name), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(OUT, { recursive: true });

  for (const rel of ASSETS) {
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
    console.log('built', path.relative(ROOT, dest));
  }

  console.log(`\n${ASSETS.length} asset(s) -> ${path.relative(ROOT, OUT)}/`);
}

main();
