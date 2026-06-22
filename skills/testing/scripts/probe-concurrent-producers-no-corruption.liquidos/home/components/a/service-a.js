#!/usr/bin/env node
// Producer A. Each cycle it OPENS a streaming lqpatch for #a-status,
// holds it open for a beat, then closes it — printing the marker across
// several stdout writes. While the marker is open, producer B emits its
// own complete markers. If both producers feed a single shared sniffer,
// B's close tag ends A's open stream early and B's text contaminates
// #a-status (and A's "_close" never lands). With one sniffer per
// producer, A's stream completes cleanly in its own region.
//
// Convention: stdout is the view-patch channel; stderr is diagnostics.

let k = 0;
const cycle = () => {
    k += 1;
    process.stdout.write('<lqpatch op="stream" target="#a-status"> A' + k + '_open');
    setTimeout(() => {
        process.stdout.write(' A' + k + '_close</lqpatch>\n');
    }, 200);
};

cycle();
setInterval(cycle, 500);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
