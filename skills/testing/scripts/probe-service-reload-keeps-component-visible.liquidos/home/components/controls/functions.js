// The source of the relationship: a button that fires 'press' on click.
// It also hosts the BOOT readout (boot.txt, written by the target's service
// on each boot) — the restart proof, kept OUT of the target's inert view.
export const mount = (surface) => {
    const btn = surface.querySelector('[data-restart-btn]');
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
