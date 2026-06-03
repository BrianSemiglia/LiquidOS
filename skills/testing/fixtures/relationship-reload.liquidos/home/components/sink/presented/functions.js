// Acceptor: a span whose text is set when something sends 'show'.
export const mount = (surface) => {
    const el = surface.querySelector('[data-sink]');
    surface.__io = {
        on() { return () => {}; },
        send(channel, payload) {
            if (channel !== 'show') return;
            el.textContent = String(payload);
        },
        connect() {},
    };
};
