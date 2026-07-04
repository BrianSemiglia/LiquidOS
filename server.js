#!/usr/bin/env node
'use strict';

// LiquidOS server shim.
//
// The server core is now the Go binary in go-server/ (built from go-server/*.go).
// This shim forwards argv + stdio to it and relays signals, so everything that
// spawns `node server.js` — the probe launcher (boot-workspace-sandbox.mjs), the
// Mac app, and the Electron wrapper — keeps working unchanged. The agent layer
// still runs as JS: the Go server spawns agent/sidecar.js, which hosts the
// unchanged agent runtimes (createRuntimes + createActiveRuntime).
//
// Build the binary once with:  (cd go-server && go build -o liquidos-server .)
// Override its location with LIQUIDOS_SERVER_BIN.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const bin = process.env.LIQUIDOS_SERVER_BIN || path.join(__dirname, 'go-server', 'liquidos-server');

if (!fs.existsSync(bin)) {
    console.error('liquidos-server binary not found at ' + bin);
    console.error('build it with: (cd go-server && go build -o liquidos-server .)');
    process.exit(1);
}

const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit', env: process.env });

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig); } catch {} });
}

child.on('error', err => {
    console.error('failed to start liquidos-server:', err.message);
    process.exit(1);
});

child.on('exit', (code, signal) => {
    // Mirror the child's death. Node ignores SIGPIPE by default, so re-raising
    // it wouldn't exit us — which matters for force-quit: the app closes our
    // stdout, the Go server's next write dies with SIGPIPE, and we must follow
    // it down (not linger as an orphan). So on any signal death, just exit.
    process.exit(signal ? 1 : (code == null ? 0 : code));
});
