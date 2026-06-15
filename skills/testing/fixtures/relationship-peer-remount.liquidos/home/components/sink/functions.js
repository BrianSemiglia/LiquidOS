// Acceptor: shows what it received on 'show' as visible text. Echoing the
// payload (the source's generation) is what lets a probe tell, by reading the
// view, that the relationship is wired to the CURRENT source after a re-mount.
export const mount = (surface) => {
    const el = surface.querySelector('span');
    surface.__io = {
        on() { return () => {}; },
        send(channel, payload) {
            if (channel !== 'show') return;
            el.textContent = 'received: ' + String(payload);
        },
        connect() {},
    };
};
