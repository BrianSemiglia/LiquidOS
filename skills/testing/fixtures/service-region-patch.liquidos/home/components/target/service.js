#!/usr/bin/env node
// Run-mode service for the service-region-patch probe. It updates only
// the #status region of its view by printing lqpatch to stdout — the
// shared view channel the agent also patches through — on a short
// interval. It never rewrites the whole view, so a sibling the user is
// editing (#user-note) is left untouched.
//
// Convention: stdout is the view-patch channel (lqpatch); stderr is for
// diagnostics and stays in the server log.

let n = 0;
const tick = () => {
    n += 1;
    process.stdout.write('<lqpatch op="stream" target="#status"> STEP_' + n + '</lqpatch>\n');
};

tick();
setInterval(tick, 250);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
