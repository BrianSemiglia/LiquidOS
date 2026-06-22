// Reproduces the two presentation behaviors that broke the requirements
// modal in real workspaces:
//
//   1. A perspective + transform-style stacking context. Descendant
//      position: fixed elements get trapped inside it instead of escaping
//      to the viewport. (Killed the CSS-pin "is-requirements-open" approach.)
//
//   2. A cached lastItems list that the canvas re-reads on workspace-file
//      SSE events to re-place without going through any harness API. When
//      the modal opens, the cached list still references the real item —
//      so a state-driven re-place would yank it out of the body overlay
//      and back into the canvas tree. (Killed the bare "move item to body"
//      approach.)
//
// Both behaviors are reproduced here in the new-shape style: the canvas
// owns its render loop and components are <liquidos-file path="component.html">
// inside .item wrappers; the canvas never touches lib internals.

export default (root, context = {}) => {
    const { canvasName, fetchJson, onWorkspaceEvent } = context;
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

    const INDEX_PATH = canvasName + '/index.json';
    let lastItems = [];

    const wrappersByPath = new Map();

    const applyPlacement = () => {
        lastItems.forEach((path, index) => {
            let wrap = wrappersByPath.get(path);
            if (!wrap) {
                wrap = document.createElement('section');
                wrap.className = 'item';
                wrap.dataset.componentPath = path;
                const card = document.createElement('div');
                card.className = 'card';
                card.appendChild(wrap);
                const file = document.createElement('liquidos-file');
                file.setAttribute('path', canvasName + '/' + path);
                wrap.appendChild(file);
                world.appendChild(card);
                wrappersByPath.set(path, wrap);
            }
            const card = wrap.parentElement;
            card.style.transform = 'translate3d(' + (index * 500) + 'px, 0, 0)';
        });
        // Drop wrappers for components no longer in the list.
        for (const [path, wrap] of wrappersByPath) {
            if (!lastItems.includes(path)) {
                wrap.parentElement?.remove();
                wrappersByPath.delete(path);
            }
        }
    };

    const loadInput = async () => {
        if (typeof fetchJson !== 'function') return;
        const json = await fetchJson(INDEX_PATH);
        lastItems = Array.isArray(json?.components) ? json.components.map(String) : [];
        applyPlacement();
    };

    // Same pattern the original used to fail at: re-read state on every
    // workspace-file SSE event, then re-place.
    const unsubscribe = typeof onWorkspaceEvent === 'function'
        ? onWorkspaceEvent(payload => {
            if (payload?.type === 'workspace-file') applyPlacement();
        })
        : () => {};

    loadInput();

    return {
        teardown() {
            unsubscribe();
            style.remove();
            stage.remove();
        }
    };
};
