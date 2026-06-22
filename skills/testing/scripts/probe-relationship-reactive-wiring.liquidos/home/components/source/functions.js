export const mount = (surface) => {
    surface.__io = {
        on(channel, fn) {
            if (channel === 'val' && typeof fn === 'function') { fn('FROM_SOURCE'); return () => {}; }
            return () => {};
        },
        send() {},
    };
};
