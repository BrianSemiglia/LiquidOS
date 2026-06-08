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

const morph = (target, sourceHtml) => {
    // Minimal DOM diff. Replaces the entire subtree but tries to reuse
    // matching same-tag children in order so custom-element instances
    // (and their internal state) survive when their position is stable.
    // This is enough for SSE-driven content updates of view-like files.
    // For finer control (lists with re-ordering, drag preservation),
    // morphdom is the upgrade path.
    const tpl = document.createElement('template');
    tpl.innerHTML = sourceHtml;
    morphChildren(target, tpl.content);
};

const morphChildren = (oldParent, newParent) => {
    const oldKids = Array.from(oldParent.childNodes);
    const newKids = Array.from(newParent.childNodes);
    const max = Math.max(oldKids.length, newKids.length);
    for (let i = 0; i < max; i++) {
        const o = oldKids[i];
        const n = newKids[i];
        if (!o && n) { oldParent.appendChild(n.cloneNode(true)); continue; }
        if (o && !n) { o.remove(); continue; }
        morphNode(o, n);
    }
};

const morphNode = (oldNode, newNode) => {
    if (oldNode.dataset?.lcPreserve !== undefined) return;
    if (oldNode.nodeType !== newNode.nodeType || oldNode.nodeName !== newNode.nodeName) {
        oldNode.replaceWith(newNode.cloneNode(true));
        return;
    }
    if (oldNode.nodeType === Node.TEXT_NODE || oldNode.nodeType === Node.COMMENT_NODE) {
        if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
        return;
    }
    if (oldNode.nodeType !== Node.ELEMENT_NODE) return;

    // Sync attributes.
    const oldAttrs = oldNode.attributes;
    for (let i = oldAttrs.length - 1; i >= 0; i--) {
        const a = oldAttrs[i];
        if (!newNode.hasAttribute(a.name)) oldNode.removeAttribute(a.name);
    }
    for (const a of newNode.attributes) {
        if (oldNode.getAttribute(a.name) !== a.value) oldNode.setAttribute(a.name, a.value);
    }

    // Preserve form values + focus that the live DOM holds and the
    // re-rendered HTML wouldn't (HTML attributes carry initial values,
    // not current property values).
    if (oldNode.tagName === 'INPUT' || oldNode.tagName === 'TEXTAREA') {
        const active = document.activeElement === oldNode;
        if (oldNode.tagName === 'INPUT' && oldNode.type === 'checkbox') {
            oldNode.checked = newNode.hasAttribute('checked');
        } else if (oldNode.tagName === 'INPUT' && oldNode.type === 'radio') {
            oldNode.checked = newNode.hasAttribute('checked');
        } else if (!active) {
            const incoming = newNode.value || newNode.textContent || '';
            if (oldNode.value !== incoming) oldNode.value = incoming;
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
        if (this._mode === 'run') this.startService();
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
            let content = await r.text();
            // .json files with an html field render that. Lets a component
            // reference its service-emitted view.json as if it were HTML —
            // no extra element needed.
            if (this._path.endsWith('.json')) {
                try {
                    const parsed = JSON.parse(content);
                    if (typeof parsed?.html === 'string') content = parsed.html;
                } catch { /* not JSON-with-html, treat as raw text */ }
            }
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
