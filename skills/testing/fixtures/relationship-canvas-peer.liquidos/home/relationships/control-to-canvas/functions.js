export const mount = (surface) => {
    let off = null;
    surface.__io = {
        peers: ['control', 'canvas'],
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const from = peers['control'];
            const to = peers['canvas'];
            if (!from || !to) return;
            off = from.on('value', v => to.send('drive', v));
        },
    };
    return () => { if (off) { try { off(); } catch {} off = null; } };
};
