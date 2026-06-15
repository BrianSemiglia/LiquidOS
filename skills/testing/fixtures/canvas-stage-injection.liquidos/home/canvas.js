// Mirrors the gadgets ("room-3d") canvas pattern at minimum size: the
// canvas owns a full-screen stage + world, wraps each item inside a
// per-item card in the world, and teardown() wipes root via
// innerHTML=''. Components are free to inject their own DOM into the
// stage (as the forest does with its WebGL backdrop) — that injected DOM
// lives in canvas-owned space and is destroyed on teardown. The harness
// must re-mount components after a canvas.js reload so those injections
// rebuild; this fixture exists to prove it.

export default (root) => {
    const style = document.createElement('style');
    style.textContent = `
        .probe-room-stage { position: fixed; inset: 0; overflow: hidden; background: #0f1117; }
        .probe-room-world { position: absolute; inset: 0; display: grid; grid-auto-flow: column; gap: 32px; padding: 60px; place-items: center; }
        .probe-room-card { display: grid; place-items: center; min-width: 220px; min-height: 160px; border: 3px solid #6ee7a1; border-radius: 16px; color: #6ee7a1; font: 700 22px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    `;
    root.appendChild(style);

    const stage = document.createElement('div');
    stage.className = 'probe-room-stage';
    const world = document.createElement('div');
    world.className = 'probe-room-world';
    stage.appendChild(world);
    // Visible build label. Editing its text below bumps canvas.js (triggering
    // a reload) AND gives the probe an on-screen signal that the new canvas
    // mounted — no private attribute needed.
    const build = document.createElement('div');
    build.textContent = 'canvas build alpha';
    build.style.cssText = 'position:absolute;top:8px;left:8px;color:#6ee7a1;font:600 13px system-ui;z-index:2;';
    stage.appendChild(build);
    root.appendChild(stage);

    return {
        place(items) {
            const kept = new Set();
            items.forEach(item => {
                let wrap = item.parentElement;
                const hasWrap = wrap && wrap.classList && wrap.classList.contains('probe-room-card');
                if (!hasWrap) {
                    wrap = document.createElement('div');
                    wrap.className = 'probe-room-card';
                    wrap.appendChild(item);
                    world.appendChild(wrap);
                }
                kept.add(wrap);
            });
            Array.from(world.querySelectorAll('.probe-room-card')).forEach(w => {
                if (!kept.has(w)) w.remove();
            });
        },
        teardown() {
            root.innerHTML = '';
        }
    };
};
