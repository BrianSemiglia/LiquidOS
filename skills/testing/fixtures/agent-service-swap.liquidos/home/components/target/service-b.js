#!/usr/bin/env node
// Service "B" — the one the probe swaps to. Paints SERVICE_B_LIVE into the
// component's #svc region, replacing service-a's marker once the harness
// spawns it. Convention: stdout is the view-patch channel (lqpatch).
const paint = () => process.stdout.write('<lqpatch op="replace" target="#svc">SERVICE_B_LIVE</lqpatch>\n');
paint();
setInterval(paint, 200);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
