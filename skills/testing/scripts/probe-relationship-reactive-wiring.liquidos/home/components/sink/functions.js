export const mount = (surface) => {
    surface.__io = {
        on() { return () => {}; },
        send(channel, payload) {
            if (channel === 'val') {
                const out = surface.querySelector('#sink-out');
                if (out) out.textContent = String(payload);
            }
        },
    };
};
