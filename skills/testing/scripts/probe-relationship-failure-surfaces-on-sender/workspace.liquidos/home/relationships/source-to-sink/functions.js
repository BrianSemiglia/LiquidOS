// v1: forwards button presses to sink with the label "v1".
export const mount = (surface) => {
    let off = null;
    surface.__io = {
        peers: ['source', 'sink'],
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const src = peers['source'];
            const dst = peers['sink'];
            if (!src || !dst) return;
            off = src.on('press', () => dst.send('show', 'v1'));
        },
    };
    return () => { if (off) { try { off(); } catch {} ; off = null; } };
};
