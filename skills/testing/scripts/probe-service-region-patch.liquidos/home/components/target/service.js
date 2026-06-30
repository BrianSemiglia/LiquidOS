#!/usr/bin/env node
// Run-mode service for the service-region-patch probe. It updates only the
// #status region by rewriting its own status.html on a short interval — a
// plain file write, no view channel (no fd 3, no lqpatch). The <liquidos-file>
// that renders status.html morphs each change in, so the sibling #user-note
// the user is editing is never touched. stdout/stderr are ordinary logs.
const fs = require('fs');
const path = require('path');
const statusPath = path.join(__dirname, 'status.html');
let n = 0;
let steps = '';
const tick = () => {
  n += 1;
  steps += ' STEP_' + n;
  fs.writeFileSync(statusPath, `<span id="status" data-marker>WAITING${steps}</span>\n`);
};
tick();
setInterval(tick, 250);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
