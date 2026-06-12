#!/usr/bin/env node
// Producer for component A. Each tick it patches its OWN region (#a-own)
// and also tries to patch component B's region (#b-guarded). A service is
// confined to its own component, so the first patch must land and the
// second must be rejected — A cannot write into B's region.
//
// Convention: stdout is the view-patch channel; stderr is diagnostics.

let n = 0;
const tick = () => {
    n += 1;
    process.stdout.write('<lqpatch op="stream" target="#a-own"> OWN_' + n + '</lqpatch>\n');
    process.stdout.write('<lqpatch op="stream" target="#b-guarded"> INTRUDER_' + n + '</lqpatch>\n');
};

tick();
setInterval(tick, 200);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
