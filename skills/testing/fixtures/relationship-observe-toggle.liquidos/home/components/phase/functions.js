// Acceptor + publisher: holds 'phase' as a value ('A' | 'B'). It's a property —
// settable via send('phase', v) and observable via on('phase', fn), which
// replays the current value on subscribe. The on-screen readout shows it.
//
// The A/B buttons set the value directly — a path the relationship does NOT
// drive. Because every change (button or send) notifies observers, a wire that
// observes this property stays current; a wire that doesn't would go stale.
export const mount = (surface) => {
    const out = surface.querySelector('#phase-out');
    const listeners = new Set();
    let phase = 'A';

    const setPhase = (v) => {
        if (v !== 'A' && v !== 'B') return;
        phase = v;
        if (out) out.textContent = phase;
        listeners.forEach(fn => { try { fn(phase); } catch { /* isolate */ } });
    };
    setPhase('A');

    surface.querySelector('#phase-set-a')?.addEventListener('click', () => setPhase('A'));
    surface.querySelector('#phase-set-b')?.addEventListener('click', () => setPhase('B'));

    surface.__io = {
        on(channel, fn) {
            if (channel !== 'phase' || typeof fn !== 'function') return () => {};
            listeners.add(fn);
            try { fn(phase); } catch { /* isolate */ }
            return () => listeners.delete(fn);
        },
        send(channel, payload) {
            if (channel === 'phase') setPhase(payload);
        },
    };
};
