// Plain imports — no ?v ceremony. The server versions the graph, so an edit to
// any module below (a.js, b.js) re-mounts this canvas with fresh values. The
// mount counter (on window, survives canvas re-mounts) lets the probe tell a
// real re-mount from a no-op.
import { LABEL } from './a.js';

export default function canvas(root) {
    window.__mountCount = (window.__mountCount || 0) + 1;
    const el = document.createElement('div');
    el.setAttribute('data-role', 'house');
    el.textContent = LABEL + ' #' + window.__mountCount;
    root.appendChild(el);
    return {
        place() {},
        teardown() { root.innerHTML = ''; }
    };
}
