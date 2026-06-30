#!/usr/bin/env node
// Run service for the html-edit-swaps probe. It paints its liveness marker by
// rewriting its own svc.html — a plain file write, no fd 3, no lqpatch. The
// <liquidos-file> rendering svc.html morphs it in; on swap the harness kills
// this one and the other rewrites svc.html with its own marker.
const fs = require('fs');
const path = require('path');
const svcPath = path.join(__dirname, 'svc.html');
const paint = () => fs.writeFileSync(svcPath, '<p id="svc">SERVICE_A_LIVE</p>\n');
paint();
setInterval(paint, 200);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
