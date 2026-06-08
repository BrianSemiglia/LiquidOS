// Error router — installs window.onerror / unhandledrejection once per
// page. When an error's source URL maps to a registered component
// functions.js path, writes runtime.ok=false into that component's
// diagnostics/status.json. <liquidos-component> watches its own
// diagnostics and shows a Repair button when the file says ok:false.
//
// Components register their script URL → component path mapping when
// they mount; this single listener routes errors to the right one
// without each component installing its own onerror.

const registry = new Map();   // scriptURL -> componentPath (workspace-relative)
const lastReportAt = new Map(); // componentPath -> timestamp of last write (dedup ~1.5s)
const lastErrorSeen = new Map(); // componentPath -> timestamp of any error seen (dedup-blind)

const DEDUP_MS = 1500;
// After mount() returns, wait this long for an error. If none arrives,
// the mount is presumed healthy and runtime is cleared. Must be longer
// than the realistic gap between mount and a deferred throw.
const MOUNT_QUIET_MS = 750;

const fetchJson = async path => {
    try {
        const r = await fetch('/workspace/' + path);
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
};

const writeJson = (path, content) => {
    return fetch('/workspace/' + path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(content, null, 2)
    });
};

export const reportRuntimeError = async (componentPath, message, stack) => {
    const now = Date.now();
    const last = lastReportAt.get(componentPath) || 0;
    if (now - last < DEDUP_MS) return;
    lastReportAt.set(componentPath, now);
    const statusPath = componentPath + '/diagnostics/status.json';
    const current = (await fetchJson(statusPath)) || {};
    const at = new Date().toISOString();
    const next = {
        ...current,
        updatedAt: at,
        runtime: { ok: false, error: String(message || ''), stack: String(stack || ''), at }
    };
    await writeJson(statusPath, next);
};

const errorMatchesRegistry = source => {
    for (const [scriptURL, componentPath] of registry) {
        if (source.includes(scriptURL)) return componentPath;
    }
    return null;
};

const onErrorHandler = (event) => {
    const source = String(event.filename || event.error?.stack || '');
    const componentPath = errorMatchesRegistry(source);
    if (componentPath) {
        lastErrorSeen.set(componentPath, Date.now());
        reportRuntimeError(componentPath, event.message || event.error?.message, event.error?.stack);
    }
};

// Public form for callers that already know which component the error
// belongs to (e.g. <liquidos-file script> catching an import failure
// whose stack may not include the registered URL).
export const reportComponentRuntimeError = (componentPath, message, stack) => {
    if (!componentPath) return;
    lastErrorSeen.set(componentPath, Date.now());
    reportRuntimeError(componentPath, message, stack);
};

const onRejectionHandler = (event) => {
    const reason = event.reason;
    const source = String(reason?.stack || '');
    const componentPath = errorMatchesRegistry(source);
    if (componentPath) {
        lastErrorSeen.set(componentPath, Date.now());
        reportRuntimeError(componentPath, reason?.message || String(reason), reason?.stack);
    }
};

let installed = false;
const install = () => {
    if (installed) return;
    installed = true;
    window.addEventListener('error', onErrorHandler);
    window.addEventListener('unhandledrejection', onRejectionHandler);
};

export const registerComponentScript = (scriptURL, componentPath) => {
    install();
    registry.set(scriptURL, componentPath);
};

export const unregisterComponentScript = scriptURL => {
    registry.delete(scriptURL);
};

// Called by <liquidos-file script> after a mount() returns cleanly. If
// MOUNT_QUIET_MS passes with no error attributed to this component, the
// mount is presumed healthy and runtime is cleared. Lets agents fix a
// throw by editing the source: re-mount runs clean, the diagnostic
// clears, the Repair button disappears — without the harness needing
// any file-edit heuristic.
export const noteSuccessfulMount = (componentPath) => {
    if (!componentPath) return;
    const mountAt = Date.now();
    setTimeout(async () => {
        const lastErr = lastErrorSeen.get(componentPath) || 0;
        if (lastErr > mountAt) return;     // error came in during the quiet window
        const statusPath = componentPath + '/diagnostics/status.json';
        const current = (await fetchJson(statusPath)) || {};
        if (!current.runtime || current.runtime.ok !== false) return;
        const at = new Date().toISOString();
        const next = {
            ...current,
            updatedAt: at,
            runtime: { ok: true, error: null, at }
        };
        await writeJson(statusPath, next);
    }, MOUNT_QUIET_MS);
};
