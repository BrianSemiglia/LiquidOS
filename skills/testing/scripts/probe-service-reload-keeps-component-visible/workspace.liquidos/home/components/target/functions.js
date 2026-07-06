// The target is the component under test. Its view (MARKER_BEFORE, INITIAL)
// stays inert — nothing here paints. It only acts as the sink of a
// relationship: when the controls button fires, it rewrites its OWN
// service.js (a real workspace edit), which is what drives the harness's
// scheduleRestart() — the exact "a click rewrites the service file" path
// from the bug report.
export const mount = (surface) => {
    const rel = (window.liquidos?.canvasName ? window.liquidos.canvasName + '/' : '')
        + 'components/target/service.js';
    surface.__io = {
        on() { return () => {}; },
        send(channel) {
            if (channel !== 'rewrite') return;
            fetch('/workspace/' + rel)
                .then(r => r.text())
                .then(body => fetch('/workspace/' + rel, {
                    method: 'PUT',
                    body: body + '\n// rewrite ' + Date.now() + '\n'
                }));
        },
        connect() {},
    };
};
