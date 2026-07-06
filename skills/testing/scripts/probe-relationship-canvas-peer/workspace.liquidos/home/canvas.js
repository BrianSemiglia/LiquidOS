// Canvas that renders its components via the shared CSS layout AND exposes an
// I/O endpoint of its own. canvas-owned behavior (here, a readout the user can
// see) has no card, so it joins the relationship graph by attaching root.__io.
// The harness registers it under the reserved peer name `canvas`.
import { cssLayout } from '/lib/css-layout.js';

const layout = cssLayout('');

export default (root, context) => {
    const inner = layout(root, context);

    // The canvas-owned surface a relationship can drive. Visible string so a
    // probe can assert on what the user sees, never on internals.
    const out = document.createElement('div');
    out.id = 'canvas-out';
    out.textContent = 'CANVAS_EMPTY';
    root.appendChild(out);

    root.__io = {
        // Publishes nothing — sink-only for this test (not a stub to fill in).
        on() { return () => {}; },
        // Accepts 'drive' and paints it to the on-screen readout.
        send(channel, payload) {
            if (channel === 'drive') out.textContent = String(payload);
        },
    };

    return {
        teardown() {
            out.remove();
            inner.teardown?.();
        }
    };
};
