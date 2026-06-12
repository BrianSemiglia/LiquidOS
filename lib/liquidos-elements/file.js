// <liquidos-file path="..." [run]>
//
// Default mode: fetches the file at `path`, renders its contents as the
// element's children, re-fetches and morphs on workspace-file changes.
//
// With `run` attribute: asks the harness to spawn the file as a process
// via /spawn. Restarts on file change. Kills on disconnect from the DOM
// (so a re-rendered parent that no longer includes this element
// terminates the service it was managing).
//
// Both modes share the same watch infrastructure — only the action on
// change (re-render vs re-spawn) differs.

// One morph for every file-driven update. The agent's contract is
// unchanged: it writes a file, the harness re-renders. Two extras let
// the morph stay correct against the structure LiquidOS produces:
//
//  - <liquidos-file> mounts have IDENTITY beyond position. Each is
//    keyed by (mode, path); the morph reuses live mounts by key so a
//    mount that moves keeps its running service / hydrated view / SSE
//    subscription, and a mount whose key changed is replaced wholesale
//    (the old element's disconnectedCallback tears the service down,
//    the new element's connectedCallback starts the new one).
//
//  - A custom element can advertise that its "real" authored surface
//    lives in a descendant via data-lc-morph-into="<selector>". When
//    the morph reaches such an element it descends into that surface
//    instead of fighting the chrome the element added around the
//    authored children. liquidos-component sets this in buildShell.
const fileKey = (el) => {
    const mode = el.hasAttribute('run') ? 'run'
        : el.hasAttribute('script') ? 'script'
        : 'render';
    return mode + '\0' + String(el.getAttribute('path') || '');
};

const syncAttrs = (oldNode, newNode) => {
    const oldAttrs = oldNode.attributes;
    for (let i = oldAttrs.length - 1; i >= 0; i--) {
        const a = oldAttrs[i];
        if (!newNode.hasAttribute(a.name)) oldNode.removeAttribute(a.name);
    }
    for (const a of newNode.attributes) {
        if (oldNode.getAttribute(a.name) !== a.value) oldNode.setAttribute(a.name, a.value);
    }
};

const morph = (target, sourceHtml) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = sourceHtml;
    morphChildren(target, tpl.content);
};

const morphChildren = (oldParent, newParent) => {
    // Identity-reconcile liquidos-file mounts first. Drop live mounts
    // the new content no longer declares (disconnectedCallback kills
    // the service / unsubscribes); survivors get reused by key on the
    // cursor walk below.
    const liveFiles = new Map();
    for (const el of oldParent.querySelectorAll('liquidos-file')) {
        liveFiles.set(fileKey(el), el);
    }
    const newFileKeys = new Set();
    for (const el of newParent.querySelectorAll('liquidos-file')) {
        newFileKeys.add(fileKey(el));
    }
    for (const [key, el] of liveFiles) {
        if (!newFileKeys.has(key)) {
            el.remove();
            liveFiles.delete(key);
        }
    }

    // Cursor walk over the new children. liquidos-file children go
    // where the new layout puts them, reusing the live element when
    // the key matches; everything else is morphed in place against
    // the cursor.
    const newKids = Array.from(newParent.childNodes);
    let cursorIdx = 0;
    for (const n of newKids) {
        const cursor = oldParent.childNodes[cursorIdx] || null;

        if (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'LIQUIDOS-FILE') {
            const key = fileKey(n);
            const live = liveFiles.get(key);
            const placement = live || n.cloneNode(true);
            if (cursor !== placement) {
                oldParent.insertBefore(placement, cursor);
            }
            syncAttrs(placement, n);
            cursorIdx++;
            continue;
        }

        if (!cursor) {
            oldParent.appendChild(n.cloneNode(true));
            cursorIdx++;
            continue;
        }

        if (cursor.nodeType !== n.nodeType || cursor.nodeName !== n.nodeName) {
            cursor.replaceWith(n.cloneNode(true));
            cursorIdx++;
            continue;
        }

        morphNode(cursor, n);
        cursorIdx++;
    }

    while (oldParent.childNodes[cursorIdx]) {
        oldParent.removeChild(oldParent.childNodes[cursorIdx]);
    }
};

const morphNode = (oldNode, newNode) => {
    if (oldNode.dataset?.lcPreserve !== undefined) return;
    if (oldNode.nodeType === Node.TEXT_NODE || oldNode.nodeType === Node.COMMENT_NODE) {
        if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
        return;
    }
    if (oldNode.nodeType !== Node.ELEMENT_NODE) return;

    syncAttrs(oldNode, newNode);

    // Descend into a designated authored surface if the element points
    // us at one (e.g. liquidos-component's buildShell sets
    // data-lc-morph-into=".surface" so the chrome doesn't get diffed
    // against the file's authored children).
    const into = oldNode.dataset?.lcMorphInto;
    if (into) {
        const inner = oldNode.querySelector(into);
        if (inner) {
            morphChildren(inner, newNode);
            return;
        }
    }

    morphChildren(oldNode, newNode);
};

class LiquidOSFile extends HTMLElement {
    constructor() {
        super();
        this._sseUnsubscribe = null;
        this._serviceId = null;
        this._currentHtml = '';
        this._initialized = false;
        this._restartTimer = null;
        this._path = '';
        this._mode = 'render';                    // 'render' | 'run' | 'script'
        this._scriptVersion = 0;
        this._scriptCleanup = null;
    }

    static get observedAttributes() { return ['path', 'run', 'script']; }

    // Called by persistHostComponent on a clone of this element. The
    // default ("render") mode hydrates its children from the referenced
    // file at runtime — that content is fetched again on next load, so
    // persisting it just bloats the source. (Run / script modes keep
    // their (empty) children untouched.)
    prepareForPersist() {
        if (!this.hasAttribute('run') && !this.hasAttribute('script')) {
            this.innerHTML = '';
        }
    }

    connectedCallback() {
        if (this._initialized) return;
        this._initialized = true;
        this._path = String(this.getAttribute('path') || '').trim();
        // Resolve canvas-relative paths against the active canvas. Agents
        // write `components/foo/...` in component markup; we prefix with the
        // canvas name to produce the workspace-relative path the harness
        // serves. Paths that already start with the canvas name are left
        // alone, as are absolute paths starting with `/`.
        const canvas = window.liquidos?.canvasName;
        if (canvas && this._path && !this._path.startsWith('/') && !this._path.startsWith(canvas + '/')) {
            this._path = canvas + '/' + this._path;
        }
        if (this._path.startsWith('/')) this._path = this._path.slice(1);
        if (this.hasAttribute('run')) this._mode = 'run';
        else if (this.hasAttribute('script')) this._mode = 'script';
        else this._mode = 'render';
        if (!this._path) return;
        if (this._mode === 'run') {
            // Confine this service's view patches to its own component
            // before it can emit. The key matches the script path the
            // server tags the service's stdout with.
            const host = this.closest('liquidos-component');
            if (host) window.liquidos?.bindProducerScope?.('service:' + this._path, host);
            this.startService();
        }
        else if (this._mode === 'script') {
            this.loadAndRunScript();
            // Sibling renders may produce the DOM this script needs to find
            // via querySelector after our first mount has already run. Re-
            // mount whenever a sibling fires liquidos:rendered.
            const parent = this.parentElement;
            if (parent) {
                this._renderedHandler = () => this.loadAndRunScript();
                parent.addEventListener('liquidos:rendered', this._renderedHandler);
            }
        }
        else this.loadAndRender();
        const onEvent = window.liquidos?.onWorkspaceEvent;
        if (typeof onEvent !== 'function') return;
        this._sseUnsubscribe = onEvent(payload => {
            if (payload?.type !== 'workspace-file') return;
            if (payload.path !== this._path) return;
            if (this._mode === 'run') this.scheduleRestart();
            else if (this._mode === 'script') this.loadAndRunScript();
            else this.loadAndRender();
        });
    }

    disconnectedCallback() {
        // Defer teardown so a DOM move (disconnect immediately followed by
        // reconnect) doesn't kill the running service. By the next
        // microtask, isConnected reflects the final state.
        queueMicrotask(() => {
            if (this.isConnected) return;
            if (this._sseUnsubscribe) { this._sseUnsubscribe(); this._sseUnsubscribe = null; }
            if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
            if (this._serviceId) {
                window.liquidos?.killService?.(this._serviceId);
                this._serviceId = null;
            }
            if (this._mode === 'run') {
                window.liquidos?.unbindProducerScope?.('service:' + this._path);
            }
            if (this._scriptCleanup) {
                try { this._scriptCleanup(); } catch (e) { console.error('script cleanup threw', e); }
                this._scriptCleanup = null;
            }
            if (this._renderedHandler && this.parentElement) {
                this.parentElement.removeEventListener('liquidos:rendered', this._renderedHandler);
                this._renderedHandler = null;
            }
        });
    }

    async loadAndRender() {
        try {
            const r = await fetch('/workspace/' + this._path);
            if (!r.ok) {
                if (!this._currentHtml) {
                    this.innerHTML = '<div style="padding:1rem;color:rgba(255,180,180,0.7);font:13px sans-serif;">missing: ' + this._path + '</div>';
                }
                return;
            }
            const content = await r.text();
            if (content === this._currentHtml) return;
            if (!this._currentHtml) {
                this.innerHTML = content;
            } else {
                morph(this, content);
            }
            this._currentHtml = content;
            // Tell sibling script elements (which may have mounted before
            // we rendered) that the view they need is now available.
            this.dispatchEvent(new CustomEvent('liquidos:rendered', { bubbles: true }));
        } catch (e) {
            console.error('liquidos-file load failed', this._path, e);
        }
    }

    async startService() {
        if (this._serviceId) return;
        const result = await window.liquidos?.runService?.({ script: this._path, label: this._path });
        if (result?.id) this._serviceId = result.id;
    }

    scheduleRestart() {
        if (this._restartTimer) clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(async () => {
            this._restartTimer = null;
            if (this._serviceId) {
                await window.liquidos?.killService?.(this._serviceId);
                this._serviceId = null;
            }
            this.startService();
        }, 250);
    }

    async loadAndRunScript() {
        // Dynamic-import the file as an ES module. If it exports `mount`,
        // call it with the element's parent as the surface and capture
        // the cleanup (function or { destroy() }).
        //
        // Multiple calls can be in-flight simultaneously — initial mount
        // plus a sibling render firing liquidos:rendered. Use a version
        // counter to discard stale resolutions: if a newer call started
        // while we were awaiting import, abort instead of running mount
        // (which would otherwise overwrite the newer cleanup and leak a
        // mount with no way to tear it down).
        const v = ++this._scriptVersion;
        if (this._scriptCleanup) {
            try { this._scriptCleanup(); } catch (e) { console.error('script cleanup threw', e); }
            this._scriptCleanup = null;
        }
        const url = '/workspace/' + this._path + '?v=' + v;
        // Tell the error router that errors from this URL belong to the
        // nearest <liquidos-component> ancestor, so its diagnostics
        // observer surfaces a Repair button when this script throws.
        const componentEl = this.closest('liquidos-component');
        // <liquidos-component> exposes the resolved workspace-relative path
        // it uses to read its own diagnostics; register the error router
        // against that same path so written diagnostics land where the
        // element is looking.
        const componentPath = componentEl?.workspacePath || componentEl?.getAttribute('path');
        if (componentPath) {
            window.liquidos?.registerComponentScript?.(url, componentPath);
        }
        let mod;
        try { mod = await import(url); }
        catch (e) {
            console.error('failed to import ' + this._path, e);
            // Surface the import failure the same way a thrown error
            // would: route it through the error router so diagnostics
            // shows runtime ok:false and the Repair button appears.
            if (componentPath) {
                window.liquidos?.reportComponentRuntimeError?.(componentPath, e?.message || String(e), e?.stack || '');
            }
            return;
        }
        if (v !== this._scriptVersion) return;          // superseded
        if (typeof mod.mount !== 'function') return;
        const surface = this.parentElement || this;
        try {
            const result = mod.mount(surface);
            if (v !== this._scriptVersion) {
                // A newer call came in between mount() and now. Clean up
                // immediately so we don't leak this instance.
                const cleanup = typeof result === 'function'
                    ? result
                    : (result && typeof result.destroy === 'function' ? () => result.destroy() : null);
                if (cleanup) { try { cleanup(); } catch {} }
                return;
            }
            this._scriptCleanup = typeof result === 'function'
                ? result
                : (result && typeof result.destroy === 'function' ? () => result.destroy() : null);
            // The mount returned without throwing. If no error reaches
            // the router in the quiet window that follows, the router
            // clears runtime ok:true — Repair button disappears, as if
            // the user's fix worked.
            if (componentPath) window.liquidos?.noteSuccessfulMount?.(componentPath);
            // Mounts may set surface.__io; let the harness re-attempt
            // wire-up so relationships find their fresh peer.
            window.liquidos?.scheduleWireIO?.();
        } catch (e) {
            console.error('mount threw', e);
        }
    }
}

// Custom elements default to inline display, which collapses to h:0 around
// block content. Make the element a transparent flow container.
if (!document.getElementById('liquidos-file-style')) {
    document.head.appendChild(Object.assign(document.createElement('style'), {
        id: 'liquidos-file-style',
        textContent: 'liquidos-file { display: contents; }'
    }));
}

if (!customElements.get('liquidos-file')) customElements.define('liquidos-file', LiquidOSFile);

export { LiquidOSFile };
