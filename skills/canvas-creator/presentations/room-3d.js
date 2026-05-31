//
// room-3d.js — first-person 3D presentation.
//
// Contract:
//   default export: factory (root, context) -> { place(items, components, state), teardown() }
//   - place: positions/repositions cards given the latest state.
//   - teardown: removes the presentation's DOM and event listeners.
//
// Controls:
//   - Trackpad/wheel two-finger scroll: yaw (horizontal) + pitch (vertical).
//   - WASD / arrows: move in the camera's plane.
//   - Shift: sprint.
//
// State (lives in workspace files, hot-reloaded by the harness):
//   <canvas>/state.room-3d.json
//     { "camera": { "x", "y", "z", "yaw", "pitch" } }
//   <canvas>/components/<name>/state.room-3d.json
//     { "position": [x, y, z] }
//
// Camera changes are POSTed back to the harness (debounced) so refreshes,
// canvas-switches, and other surfaces see the same view. Component positions
// honor the per-component state file if present; otherwise components are
// tiled in a row.
//

const PRESENTATION_NAME = 'room-3d';

export default (root, context = {}) => {
    const canvasPath = context.canvasPath || 'default';
    let camera = { x: 0, y: 0, z: 600, yaw: 0, pitch: 0 };

    // --- DOM setup ----------------------------------------------------------

    root.innerHTML = '';
    const styleEl = document.createElement('style');
    styleEl.textContent = `
        .presentation-room-stage { position: relative; width: 100%; height: 100vh; overflow: hidden; perspective: 1200px; perspective-origin: 50% 50%; background: radial-gradient(ellipse at center, rgba(40,42,54,0.95) 0%, rgba(15,16,22,1) 70%); }
        .presentation-room-world { position: absolute; left: 50%; top: 50%; transform-style: preserve-3d; will-change: transform; }
        .presentation-room-card { position: absolute; left: 0; top: 0; width: 640px; margin: -200px 0 0 -320px; transform-style: preserve-3d; will-change: transform; transform-origin: center center; }
        .presentation-room-card > * { width: 100%; }
        .presentation-room-floor { position: absolute; left: -2000px; top: 0; width: 4000px; height: 4000px; transform: rotateX(90deg) translateZ(-300px); background: repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 100px), repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 100px); pointer-events: none; }
        .presentation-room-hint { position: absolute; left: 12px; bottom: 12px; color: rgba(255,255,255,0.5); font-size: 11px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; pointer-events: none; }
        .presentation-room-debug { position: absolute; right: 12px; bottom: 12px; padding: 6px 9px; border-radius: 6px; background: rgba(0,0,0,0.55); color: rgba(255,255,255,0.7); font: 10px ui-monospace, Menlo, monospace; pointer-events: none; white-space: pre; }
    `;
    root.appendChild(styleEl);

    const stage = document.createElement('div');
    stage.className = 'presentation-room-stage';
    const world = document.createElement('div');
    world.className = 'presentation-room-world';
    const floor = document.createElement('div');
    floor.className = 'presentation-room-floor';
    world.appendChild(floor);
    stage.appendChild(world);

    const hint = document.createElement('div');
    hint.className = 'presentation-room-hint';
    hint.textContent = 'scroll to look · WASD to move · shift sprint';
    stage.appendChild(hint);

    const debugEl = document.createElement('div');
    debugEl.className = 'presentation-room-debug';
    stage.appendChild(debugEl);
    root.appendChild(stage);

    // --- State persistence --------------------------------------------------

    const postState = (scope, body) =>
        fetch('/state', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope, presentation: PRESENTATION_NAME, ...body })
        }).catch(() => { /* best-effort */ });

    let pendingCameraWrite = null;
    // Snapshot of the last camera object we POSTed. When the harness echoes
    // a state-changed event back, place() compares incoming sourceCamera to
    // this snapshot — if equal, the echo is our own write and we skip the
    // adopt+updateWorld lines entirely (no compositor work for our own
    // round-trip).
    let lastWrittenCameraSig = '';
    const cameraSig = (c) => c ? `${c.x}|${c.y}|${c.z}|${c.yaw}|${c.pitch}` : '';
    const persistCamera = () => {
        clearTimeout(pendingCameraWrite);
        pendingCameraWrite = setTimeout(() => {
            lastWrittenCameraSig = cameraSig(camera);
            postState('canvas', { data: { camera } });
        }, 600);
    };

    // --- Camera + render ----------------------------------------------------

    const keys = new Set();

    const updateDebug = () => {
        debugEl.textContent =
            `presentation room-3d` +
            `\ncamera x=${camera.x.toFixed(0)} z=${camera.z.toFixed(0)} yaw=${camera.yaw.toFixed(0)} pitch=${camera.pitch.toFixed(0)}` +
            `\nkeys=${[...keys].join(',') || '·'}`;
    };

    let lastWorldTransform = '';
    const updateWorld = () => {
        const next =
            `translateZ(800px) ` +
            `rotateX(${-camera.pitch}deg) rotateY(${-camera.yaw}deg) ` +
            `translate3d(${-camera.x}px, ${-camera.y}px, ${-camera.z}px)`;
        // Avoid re-assigning the same transform: in WebKit, restyling a
        // composited 3D parent with `will-change: transform` can re-rasterize
        // its subtree for a frame even when the string is identical.
        if (next !== lastWorldTransform) {
            world.style.transform = next;
            lastWorldTransform = next;
        }
        updateDebug();
    };

    // --- Input handlers -----------------------------------------------------

    const onWheel = (e) => {
        e.preventDefault();
        camera.yaw -= (e.deltaX || 0) * 0.4;
        camera.pitch = Math.max(-89, Math.min(89, camera.pitch - (e.deltaY || 0) * 0.4));
        updateWorld();
        persistCamera();
    };

    const isTextEditingTarget = (el) =>
        el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

    const onKey = (e) => {
        const k = e.key.toLowerCase();
        const tracked = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', ' '];
        if (!tracked.includes(k)) return;
        if (isTextEditingTarget(document.activeElement)) return;
        if (e.type === 'keydown') keys.add(k); else keys.delete(k);
        e.preventDefault();
        updateDebug();
    };

    stage.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);

    let rafHandle = null;
    const tick = () => {
        if (keys.size) {
            const sprinting = keys.has('shift');
            const speed = sprinting ? 24 : 12;
            // Camera-relative basis. Yaw convention: drag/scroll right
            // decreases yaw (yaw -= dx). So:
            //   forward = (-sin yaw, 0, -cos yaw)
            //   left    = ( cos yaw, 0, -sin yaw)
            const forwardMag = (keys.has('w') || keys.has('arrowup')) ? 1 : (keys.has('s') || keys.has('arrowdown')) ? -1 : 0;
            const leftMag = (keys.has('a') || keys.has('arrowleft')) ? -1 : (keys.has('d') || keys.has('arrowright')) ? 1 : 0;
            if (forwardMag || leftMag) {
                const yr = camera.yaw * Math.PI / 180;
                const sinY = Math.sin(yr);
                const cosY = Math.cos(yr);
                camera.x += (forwardMag * -sinY + leftMag * cosY) * speed;
                camera.z += (forwardMag * -cosY + leftMag * -sinY) * speed;
                updateWorld();
                persistCamera();
            }
        }
        rafHandle = requestAnimationFrame(tick);
    };
    rafHandle = requestAnimationFrame(tick);

    return {
        place(items, components, state) {
            // Adopt camera state, but skip our own echoed writes: when the
            // signature matches what we just POSTed, the incoming camera is
            // the round-trip of our own value — no compositor work needed.
            const sourceCamera = state?.canvas?.camera;
            const isSelfEcho = sourceCamera && cameraSig(sourceCamera) === lastWrittenCameraSig;
            if (sourceCamera && !isSelfEcho) {
                camera = {
                    x: typeof sourceCamera.x === 'number' ? sourceCamera.x : camera.x,
                    y: typeof sourceCamera.y === 'number' ? sourceCamera.y : camera.y,
                    z: typeof sourceCamera.z === 'number' ? sourceCamera.z : camera.z,
                    yaw: typeof sourceCamera.yaw === 'number' ? sourceCamera.yaw : camera.yaw,
                    pitch: typeof sourceCamera.pitch === 'number' ? sourceCamera.pitch : camera.pitch
                };
                updateWorld();
            }

            // Diff-friendly placement: reuse each item's existing wrapper
            // instead of rebuilding it. Rebuilding rips items out of their
            // parents and re-appends them, which causes the entire 3D scene
            // to re-rasterize for a frame.
            const count = items.length;
            const spacing = 700;
            const totalWidth = (count - 1) * spacing;
            const componentStates = state?.components || {};
            const keptWraps = new Set();
            items.forEach((item, index) => {
                let cardWrap = item.parentElement;
                const hasWrap = cardWrap && cardWrap.classList && cardWrap.classList.contains('presentation-room-card');
                if (!hasWrap) {
                    cardWrap = document.createElement('div');
                    cardWrap.className = 'presentation-room-card';
                    cardWrap.appendChild(item);
                    world.appendChild(cardWrap);
                }
                const scope = components?.[index]?.scope;
                const componentState = scope && componentStates[scope];
                const persistedPosition = componentState?.position;
                const [x, y, z] = Array.isArray(persistedPosition) && persistedPosition.length === 3
                    ? persistedPosition
                    : [-totalWidth / 2 + index * spacing, 0, 0];
                const nextTransform = `translate3d(${x}px, ${y}px, ${z}px)`;
                if (cardWrap.style.transform !== nextTransform) {
                    cardWrap.style.transform = nextTransform;
                }
                keptWraps.add(cardWrap);
            });
            Array.from(world.querySelectorAll('.presentation-room-card')).forEach(wrap => {
                if (!keptWraps.has(wrap)) wrap.remove();
            });
        },
        teardown() {
            clearTimeout(pendingCameraWrite);
            // One final synchronous-ish write so the camera state matches what
            // was on screen when the presentation went away.
            postState('canvas', { data: { camera } });
            cancelAnimationFrame(rafHandle);
            stage.removeEventListener('wheel', onWheel);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('keyup', onKey);
            root.innerHTML = '';
        }
    };
};
