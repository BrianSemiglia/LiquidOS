// Error router — installs window.onerror / unhandledrejection once per
// page. When an error's source URL maps to a registered component
// functions.js path, posts runtime.ok=false for that component.
// <liquidos-component> watches its own diagnostics and shows a Repair
// button when the file says ok:false.
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

// Post the runtime category and let the server merge it into status.json.
// Reading the file here to merge client-side would be a read-modify-write
// racing every other writer of the same file — two overlapping cycles each
// read the same "before" copy and the last write drops the other's category.
// The server does the merge under a lock, so there is one writer.
const postRuntime = (componentPath, data) =>
    fetch('/diagnostics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ componentPath, category: 'runtime', data })
    }).catch(() => {});

export const reportRuntimeError = async (componentPath, message, stack) => {
    const now = Date.now();
    const last = lastReportAt.get(componentPath) || 0;
    if (now - last < DEDUP_MS) return;
    lastReportAt.set(componentPath, now);
    return postRuntime(componentPath, {
        ok: false,
        error: String(message || ''),
        stack: String(stack || '')
    });
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
        // Read only to decide whether there is anything to clear — a stale
        // read costs at worst a redundant write or a skipped clear the next
        // mount repeats. The diagnostic survives a reload, so in-memory state
        // can't answer this.
        let current = null;
        try {
            const r = await fetch('/workspace/' + componentPath + '/diagnostics/status.json');
            if (r.ok) current = await r.json();
        } catch { /* unreadable: nothing to clear */ }
        if (!current?.runtime || current.runtime.ok !== false) return;
        await postRuntime(componentPath, { ok: true, error: null });
    }, MOUNT_QUIET_MS);
};
