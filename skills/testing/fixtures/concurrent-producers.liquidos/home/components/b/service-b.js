#!/usr/bin/env node
// Producer B. Emits complete streaming lqpatch markers for #b-status on a
// fast interval, so several land while producer A's marker is held open.
// Its patches must reach #b-status — not get swallowed by A's stream.
//
// Convention: stdout is the view-patch channel; stderr is diagnostics.

let k = 0;
const tick = () => {
    k += 1;
    process.stdout.write('<lqpatch op="stream" target="#b-status"> B_' + k + '</lqpatch>\n');
};

setInterval(tick, 100);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
