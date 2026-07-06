// Like the forest: this component paints OUTSIDE its own card. It waits for
// the canvas-owned stage and injects a full-screen backdrop carrying the
// visible string the probe asserts on. The backdrop lives in canvas DOM, so
// a canvas.js teardown destroys it; only a re-mount re-injects it.

export const mount = (surface) => {
    let disposed = false;
    let node = null;

    const inject = (stage) => {
        // Clear any stale backdrop from a previous mount, then sit behind cards.
        const stale = stage.querySelector('.probe-backdrop');
        if (stale) stale.remove();
        node = document.createElement('div');
        node.className = 'probe-backdrop';
        node.textContent = 'BACKDROP LIVE';
        Object.assign(node.style, {
            position: 'absolute', inset: '0', display: 'grid', placeItems: 'center',
            font: '700 56px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            color: '#f4bf7a', background: '#1a1d27', zIndex: '0', pointerEvents: 'none',
        });
        stage.insertBefore(node, stage.firstChild);
    };

    // The stage is created by canvas.js and may not exist yet on first mount.
    let tries = 0;
    const tick = () => {
        if (disposed) return;
        const stage = document.querySelector('.probe-room-stage');
        if (stage) { inject(stage); return; }
        if (tries++ > 120) return;
        requestAnimationFrame(tick);
    };
    tick();

    return () => {
        disposed = true;
        if (node) { node.remove(); node = null; }
    };
};
