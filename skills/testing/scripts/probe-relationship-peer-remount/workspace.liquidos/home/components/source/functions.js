// Publisher: a button that emits its current generation on the 'press'
// channel. The generation is stamped into the visible "gen N" label and
// persisted there across re-mounts (the label DOM survives a script reload),
// so each fresh mount shows a higher number — a visible signal that the peer
// re-mounted with a new __io.
export const mount = (surface) => {
    const btn = surface.querySelector('button');
    const genEl = surface.querySelector('.gen');
    const n = (parseInt((genEl.textContent.match(/\d+/) || ['0'])[0], 10) || 0) + 1;
    const gen = 'gen ' + n;
    genEl.textContent = gen;
    const listeners = new Set();
    const onClick = () => listeners.forEach(fn => { try { fn(gen); } catch {} });
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
