#!/usr/bin/env node
// Long-running service for the service-restart probe. On every (re)boot it
// bumps a counter in the SEPARATE controls component — its only on-screen
// fingerprint. That increment is how the probe sees a restart actually
// happened, without painting anything into the target's own (inert) view.
// The target's service.js is rewritten (via a relationship-driven click) to
// force the harness's run-mode liquidos-file to scheduleRestart() — that
// restart is the moment the disappear-on-reload bug would show.
const fs = require('node:fs');
const path = require('node:path');
const readout = path.join(__dirname, '..', 'controls', 'boot.txt');
let n = 0;
try { n = parseInt(String(fs.readFileSync(readout, 'utf8')).replace(/\D/g, ''), 10) || 0; } catch {}
fs.writeFileSync(readout, 'BOOT ' + (n + 1) + '\n');
setInterval(() => {}, 1 << 30);
