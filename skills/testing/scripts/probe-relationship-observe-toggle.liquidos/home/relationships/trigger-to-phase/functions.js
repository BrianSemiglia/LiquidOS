// A pulse is an event; phase is a value. To flip the value on each event the
// relationship must know the current value — so it OBSERVES phase (the target's
// observable property) and writes back the opposite on each pulse. The target
// owns the value; this holds only a cache of what it last observed, reconciled
// on every change and replayed on connect, so it can't drift. No persistence.
export const mount = (surface) => {
    let off = null;
    surface.__io = {
        peers: ['trigger', 'phase'],
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const from = peers['trigger'];
            const to = peers['phase'];
            if (!from || !to) return;

            let current = 'A';
            const offValue = to.on('phase', v => { current = v; });
            const offPulse = from.on('pulse', () => {
                to.send('phase', current === 'A' ? 'B' : 'A');
            });
            off = () => {
                try { offValue(); } catch {}
                try { offPulse(); } catch {}
            };
        },
    };
    return () => { if (off) { try { off(); } catch {} ; off = null; } };
};
