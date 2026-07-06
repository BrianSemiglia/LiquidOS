// Wires the controls button to the target: a 'press' becomes a 'rewrite'
// the target acts on (rewriting its own service.js → a service restart).
// This is the "clicking through the canvas causes a service file rewrite"
// path from the bug report, driven through a real relationship.
export const mount = (surface) => {
    let off = null;
    surface.__io = {
        peers: ['controls', 'target'],
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const src = peers['controls'];
            const dst = peers['target'];
            if (!src || !dst) return;
            off = src.on('press', () => dst.send('rewrite'));
        },
    };
    return () => { if (off) { try { off(); } catch {} off = null; } };
};
