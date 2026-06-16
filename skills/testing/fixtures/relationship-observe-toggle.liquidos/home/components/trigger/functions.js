// Publisher: emits a 'pulse' event on each click — an event, not a value
// (nothing to replay; "it happened" is the whole message).
export const mount = (surface) => {
    const subs = new Set();
    const btn = surface.querySelector('#trigger-btn');
    if (btn) btn.addEventListener('click', () => subs.forEach(fn => { try { fn(); } catch { /* isolate */ } }));
    surface.__io = {
        on(channel, fn) {
            if (channel === 'pulse' && typeof fn === 'function') { subs.add(fn); return () => subs.delete(fn); }
            return () => {};
        },
        send() {},
    };
};
