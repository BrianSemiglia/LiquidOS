export const mount = (surface) => {
    let off = null;
    surface.__io = {
        peers: ['source', 'sink'],
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const from = peers['source'];
            const to = peers['sink'];
            if (!from || !to) return;
            off = from.on('val', v => to.send('val', v));
        },
    };
    return () => { if (off) { try { off(); } catch {} off = null; } };
};
