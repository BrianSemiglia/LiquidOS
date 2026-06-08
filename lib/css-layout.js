//
// cssLayout(cssString) -> presentation factory.
//
// Applies the stylesheet to <head> and renders each component listed in
// input.json (workspace-relative .html paths) into a flat stack inside the
// canvas root. Each entry becomes a <liquidos-file path="..."> — the
// custom element resolves canvas-relative paths via window.liquidos.canvasName
// and handles the actual paint, mount, and service lifecycle.
//

export const cssLayout = (cssText) => (root, context = {}) => {
    const style = document.createElement('style');
    style.textContent = cssText;
    document.head.appendChild(style);

    const { canvasName, fetchJson, onWorkspaceEvent } = context;
    const INPUT_PATH = canvasName + '/input.json';

    let componentList = [];
    let tornDown = false;
    const wrappers = new Map();

    const addComponent = rel => {
        if (wrappers.has(rel)) return;
        const wrap = document.createElement('section');
        wrap.className = 'item';
        wrap.dataset.componentPath = rel;
        const file = document.createElement('liquidos-file');
        file.setAttribute('path', canvasName + '/' + rel);
        wrap.appendChild(file);
        root.appendChild(wrap);
        wrappers.set(rel, wrap);
    };

    const removeComponent = rel => {
        wrappers.get(rel)?.remove();
        wrappers.delete(rel);
    };

    const loadInput = async () => {
        if (typeof fetchJson !== 'function') return;
        const json = await fetchJson(INPUT_PATH);
        // teardown may have fired during the await — bail out so a stale
        // fetch result doesn't add wrappers to an already-torn-down canvas
        // (leaves "missing:" noise next to a Repair card).
        if (tornDown) return;
        const next = Array.isArray(json?.components) ? json.components.map(String) : [];
        const added = next.filter(p => !componentList.includes(p));
        const removed = componentList.filter(p => !next.includes(p));
        componentList = next;
        for (const p of removed) removeComponent(p);
        for (const p of added) addComponent(p);
    };

    const unsubscribe = typeof onWorkspaceEvent === 'function'
        ? onWorkspaceEvent(payload => {
            if (payload?.type === 'workspace-file' && payload.path === INPUT_PATH) loadInput();
        })
        : () => {};

    loadInput();

    return {
        teardown() {
            tornDown = true;
            unsubscribe();
            for (const rel of [...componentList]) removeComponent(rel);
            // Also drop any wrappers added between teardown and a
            // late-resolving loadInput (defense in depth).
            for (const rel of [...wrappers.keys()]) removeComponent(rel);
            style.remove();
        }
    };
};
