// Forwards the source's press (carrying its generation) to the sink. Because
// it binds a direct reference to the source's __io at connect time, it must be
// re-wired when the source re-mounts — otherwise it keeps forwarding from the
// dead one and the sink stops echoing the current generation.
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
            off = src.on('press', payload => dst.send('show', payload));
        },
    };
    return () => { if (off) { try { off(); } catch {} ; off = null; } };
};
