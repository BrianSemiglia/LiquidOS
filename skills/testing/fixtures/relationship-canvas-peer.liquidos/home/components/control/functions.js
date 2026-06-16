export const mount = (surface) => {
    const subs = new Set();
    const btn = surface.querySelector('#control-btn');
    if (btn) btn.addEventListener('click', () => subs.forEach(fn => fn('DRIVEN_BY_CONTROL')));
    surface.__io = {
        on(channel, fn) {
            if (channel === 'value' && typeof fn === 'function') { subs.add(fn); return () => subs.delete(fn); }
            return () => {};
        },
        send() {},
    };
};
