#!/usr/bin/env node
// Producer Y. After a short startup delay (so X owns #shared first), it
// repeatedly fires a complete replace at #shared. Because X holds the
// region, Y must lose every time — Y_INTRUDER must never reach the view.
//
// Convention: stdout is the view-patch channel; stderr is diagnostics.

setTimeout(() => {
    const tick = () => {
        process.stdout.write('<lqpatch op="replace" target="#shared">Y_INTRUDER</lqpatch>\n');
    };
    tick();
    setInterval(tick, 100);
}, 800);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
