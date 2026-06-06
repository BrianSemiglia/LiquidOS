// Reproduces the two presentation behaviors that broke the requirements
// modal in real workspaces:
//
//   1. A perspective + transform-style stacking context. Descendant
//      position: fixed elements get trapped inside it instead of escaping
//      to the viewport. (Killed the CSS-pin "is-requirements-open" approach.)
//
//   2. A cached lastItems list that the canvas reuses on workspace-file
//      SSE events to re-place without going through the harness's place().
//      When the modal opens, the cached list still references the real item
//      — so a state-driven re-place yanks the item out of the body overlay
//      and back into the canvas tree. (Killed the bare "move item to body"
//      approach.)
//
// The probe writes to state.json to trigger workspace-file SSE events; this
// canvas then exercises both behaviors above. The fix lives in index.html:
// the harness fires one render right after opening the modal so the canvas
// caches the placeholder instead of the real item.

export default (root) => {
    const style = document.createElement('style');
    style.textContent = `
        .stage { position: relative; width: 100%; min-height: 100vh; perspective: 1200px; background: #0e0b1f; }
        .world { position: absolute; left: 50%; top: 50%; transform-style: preserve-3d; }
        .card { position: absolute; width: 480px; margin: -120px 0 0 -240px; transform-style: preserve-3d; }
    `;
    document.head.appendChild(style);

    const stage = document.createElement('div'); stage.className = 'stage';
    const world = document.createElement('div'); world.className = 'world';
    stage.appendChild(world);
    root.appendChild(stage);

    let lastItems = [];

    const applyPlacement = () => {
        const kept = new Set();
        lastItems.forEach((item, index) => {
            let wrap = item.parentElement;
            if (!wrap || !wrap.classList || !wrap.classList.contains('card')) {
                wrap = document.createElement('div');
                wrap.className = 'card';
                wrap.appendChild(item);
                world.appendChild(wrap);
            }
            wrap.style.transform = `translate3d(${index * 500}px, 0, 0)`;
            kept.add(wrap);
        });
        Array.from(world.querySelectorAll('.card')).forEach(wrap => {
            if (!kept.has(wrap)) wrap.remove();
        });
    };

    // Re-place on every workspace-file SSE — same pattern the gadgets 3D
    // canvas uses to react to its state files.
    const events = new EventSource('/events');
    events.onmessage = event => {
        try {
            const payload = JSON.parse(event.data);
            if (payload && payload.type === 'workspace-file') applyPlacement();
        } catch {}
    };

    return {
        place(items) {
            lastItems = items;
            applyPlacement();
        },
        teardown() {
            events.close();
            style.remove();
            stage.remove();
        }
    };
};
