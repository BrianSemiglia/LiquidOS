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

// A stable handle for a live element across a morph: its id when it has
// one, else a child-index path from the morph root.
const keyOf = (root, el) => {
    if (el.id) return '#' + el.id;
    const path = [];
    for (let n = el; n && n !== root; n = n.parentNode) {
        path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
    }
    return 'p:' + path.join(',');
};
const findByKey = (root, key) => {
    if (key.startsWith('#')) return root.querySelector(key);
    const idx = key.slice(2).split(',').filter(s => s !== '').map(Number);
    return idx.reduce((n, i) => (n ? n.childNodes[i] : null), root);
};

// Re-rendering a whole component from its file must not clobber what the
// user is doing. The file carries structure and authored content, never
// runtime state — typed values, focus, selection, scroll. So we capture
// that off the live DOM, morph, then put it back. A typed input survives a
// service patching a sibling region; focus and scroll survive too. The
// render is the same no matter who set the change, and non-destructive.
const morph = (target, sourceHtml) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = sourceHtml;

    const active = document.activeElement;
    const focusKey = active && target.contains(active) ? keyOf(target, active) : null;
    const selection = focusKey && active.selectionStart != null
        ? { start: active.selectionStart, end: active.selectionEnd } : null;
    const fields = new Map();
    target.querySelectorAll('input, textarea, select').forEach(el => {
        fields.set(keyOf(target, el), { value: el.value, checked: el.checked });
    });
    const scrolls = new Map();
    target.querySelectorAll('*').forEach(el => {
        if (el.scrollTop || el.scrollLeft) {
            scrolls.set(keyOf(target, el), { top: el.scrollTop, left: el.scrollLeft });
        }
    });

    morphChildren(target, tpl.content);

    fields.forEach((s, key) => {
        const el = findByKey(target, key);
        if (!el) return;
        // The file didn't carry a value, so keep what the user typed. If the
        // new render *did* set one (a value attribute), respect that instead.
        if (!el.value && s.value) el.value = s.value;
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = s.checked;
    });
    scrolls.forEach((s, key) => {
        const el = findByKey(target, key);
        if (el) { el.scrollTop = s.top; el.scrollLeft = s.left; }
    });
    if (focusKey) {
        const el = findByKey(target, focusKey);
        if (el && el !== document.activeElement && typeof el.focus === 'function') {
            el.focus();
            if (selection && el.setSelectionRange) {
                try { el.setSelectionRange(selection.start, selection.end); } catch {}
            }
        }
    }
};

// Fade a new element in when the morph brings it into the view — whether it's
// appended or swapped in. Only *elements* get it, so text-only changes (a
// clock tick, a price ticker, a counter) never strobe. Opacity-only (the
// .lq-enter keyframe lives in the host stylesheet) so it never fights a
// presentation's transforms. The transient class clears when the animation
// ends — via the Web Animations API, no timer — or at once when none applies
// (reduced motion).
const enterNode = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    node.classList.add('lq-enter');
    const clear = () => node.classList.remove('lq-enter');
    const anims = node.getAnimations({ subtree: false });
    if (!anims.length) { clear(); return; }
    Promise.all(anims.map(a => a.finished)).then(clear, clear);
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
            const fresh = n.cloneNode(true);
            oldParent.appendChild(fresh);
            enterNode(fresh); // new content the user sees — fade it in (no-op for text)
            cursorIdx++;
            continue;
        }

        if (cursor.nodeType !== n.nodeType || cursor.nodeName !== n.nodeName) {
            const fresh = n.cloneNode(true);
            cursor.replaceWith(fresh);
            enterNode(fresh);
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

    // An element that designates an authored surface (data-lc-morph-into, set
    // by liquidos-component's buildShell) owns a harness-injected chrome
    // wrapper. The host's own attributes and direct children are render
    // artifacts, not authored source — reconcile only the surface against the
    // file, and do NOT sync the host's attributes: the file never carries the
    // morph-into hint, so syncing here would strip it and the chrome with it.
    const into = oldNode.dataset?.lcMorphInto;
    if (into) {
        const inner = oldNode.querySelector(into);
        if (inner) {
            morphChildren(inner, newNode);
            return;
        }
    }

    syncAttrs(oldNode, newNode);
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
        this._closure = null;                     // run/script: the module's import closure
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
            // Re-run when our entry file changes OR when any module it imports
            // does (run/script only — render mode is plain HTML with no closure).
            if (payload.path !== this._path && !this._closure?.has(payload.path)) return;
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
            const content = await r.text();
            if (content === this._currentHtml) return;
            const isRerender = !!this._currentHtml;
            if (!this._currentHtml) {
                this.innerHTML = content;
            } else {
                morph(this, content);
            }
            this._currentHtml = content;
            // Tell sibling script elements (which may have mounted before
            // we rendered) that the view they need is now available.
            this.dispatchEvent(new CustomEvent('liquidos:rendered', { bubbles: true }));
            // That event bubbles UP, so it never reaches script-mode
            // <liquidos-file>s rendered INSIDE us — and a morph reuses those by
            // identity, so their connectedCallback won't re-run either. On a
            // re-render the fresh markup can reintroduce mount-managed state
            // (e.g. a re-added `inert`/disabled attribute), so re-mount our
            // script descendants directly to re-apply their side-effects. This
            // also recovers a script whose first import raced ahead of its
            // file. loadAndRunScript's version guard makes the kick idempotent.
            if (isRerender) {
                this.querySelectorAll('liquidos-file[script]').forEach(el => {
                    if (typeof el.loadAndRunScript === 'function') el.loadAndRunScript();
                });
            }
        } catch (e) {
            console.error('liquidos-file load failed', this._path, e);
        }
    }

    // Fetch this module's import closure so the SSE handler can re-run us when a
    // dependency — not just our entry file — changes. Refreshed on every run,
    // since edits can add or drop imports. Best-effort: on failure we keep the
    // prior closure and still react to our own path.
    async refreshClosure() {
        try {
            const r = await fetch('/module-closure?path=' + encodeURIComponent(this._path));
            if (r.ok) this._closure = new Set(await r.json());
        } catch { /* keep prior closure */ }
    }

    async startService() {
        if (this._serviceId) return;
        this.refreshClosure();
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
        this.refreshClosure();
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
