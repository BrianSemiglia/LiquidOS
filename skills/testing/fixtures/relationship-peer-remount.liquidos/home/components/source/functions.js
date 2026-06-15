// Publisher: a button that fires a 'press' event on click. Stamps how many
// times it has mounted on the button (data-mounts) so a probe can tell when
// it has re-mounted with a fresh __io.
export const mount = (surface) => {
    const btn = surface.querySelector('[data-source-btn]');
    btn.dataset.mounts = String((+btn.dataset.mounts || 0) + 1);
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
