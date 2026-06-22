#!/usr/bin/env node
// Service "A" — the one the probe starts with. It paints its own marker into
// the component's #svc region so a running service is visible on screen. When
// the probe swaps component.html to service-b.js, the harness kills this; A's
// marker stops being repainted and service-b paints SERVICE_B_LIVE instead —
// the swap, made visible. The harness must do this without tearing down the
// component's rendered view (the SURVIVED_THE_SWAP marker).
//
// Convention: stdout is the view-patch channel (lqpatch); stderr is diagnostics.
const paint = () => process.stdout.write('<lqpatch op="replace" target="#svc">SERVICE_A_LIVE</lqpatch>\n');
paint();
setInterval(paint, 200);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
