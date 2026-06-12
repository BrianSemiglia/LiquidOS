#!/usr/bin/env node
// Producer X. Opens an exclusive replace stream on #shared and holds it
// open, streaming X<n> tokens forever (it never closes the marker). By
// owning the region first, it should keep it: the other producer's
// replaces must be dropped, not allowed to clobber this stream.
//
// Each chunk carries trailing filler so it clears the sniffer's tail-slack
// buffer promptly (small chunks would otherwise sit buffered server-side
// waiting for a possible close tag).
//
// Convention: stdout is the view-patch channel; stderr is diagnostics.

const FILLER = ' ' + 'o'.repeat(44);
process.stdout.write('<lqpatch op="replace" target="#shared">');
let n = 0;
const tick = () => { n += 1; process.stdout.write(' X' + n + FILLER); };
tick();
setInterval(tick, 150);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
