// Publisher: a button that fires a 'press' event on click.
export const mount = (surface) => {
    const btn = surface.querySelector('[data-source-btn]');
    const listeners = new Set();
    const onClick = () => listeners.forEach(fn => { try { fn(); } catch {} });
    btn.addEventListener('click', onClick);
    surface.__io = {
        on(channel, fn) {
            if (channel !== 'press' || typeof fn !== 'function') return () => {};
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        send() {},
        connect() {},
    };
    return () => { btn.removeEventListener('click', onClick); };
};
