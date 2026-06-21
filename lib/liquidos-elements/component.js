// <liquidos-component> — standard chrome around a component's content.
//
//   <liquidos-component path="gadgets/components/audio-priority">
//     <!-- your component content -->
//   </liquidos-component>
//
// The DOM structure and CSS are copied verbatim from the original
// harness's component frame + requirements modal (see index.html).
// Nothing is reinterpreted. The element:
//   - watches <path>/feature-requirements.txt for the modal's
//     editor and PUTs on Save.
//   - watches <path>/diagnostics/status.json. When ok:false, surfaces the
//     runtime Repair callback in the chrome (and a Repair affordance
//     inside the requirements modal too).
//   - on Requirements click, moves the rendered .item into a fixed
//     .requirements-overlay (leaving a .requirements-placeholder in its
//     place), exactly like the original openRequirementsOverlay() did.

const STYLE_ID = 'liquidos-component-style';

// Verbatim CSS rules from index.html related to the component frame,
// chrome, back face, requirements region, and overlay. Any rule that
// existed there for these classes is preserved here exactly so the
// modal and chrome look the same as before.
const STYLE_TEXT = `
.share-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    user-select: none;
}
.share-toggle-label {
    font-size: 0.78rem;
    font-weight: 600;
    color: rgba(var(--fg), 0.72);
    letter-spacing: -0.005em;
}
.share-switch {
    position: relative;
    width: 36px;
    height: 20px;
    background: rgba(120, 120, 130, 0.45);
    border: 1px solid rgba(var(--fg), 0.08);
    border-radius: 999px;
    padding: 0;
    cursor: pointer;
    transition: background 0.18s ease, border-color 0.18s ease;
    flex-shrink: 0;
}
.share-switch:hover { border-color: rgba(var(--fg), 0.14); }
.share-switch[aria-checked="true"] {
    background: var(--accent);
    border-color: var(--accent-border);
}
.share-switch-thumb {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 16px;
    height: 16px;
    background: var(--accent-fg);
    border-radius: 50%;
    box-shadow: none;
    transition: transform 0.18s ease;
}
.share-switch[aria-checked="true"] .share-switch-thumb {
    transform: translateX(16px);
}
.share-switch[disabled] { opacity: 0.5; cursor: not-allowed; }

.harness-component-frame-watcher {
    position: relative;
    display: inline-grid;
    grid-template-rows: auto auto;
    grid-template-areas: "chrome" "stack";
    width: auto;
    max-width: 100%;
    min-width: 0;
    overflow: visible;
}

.component-face {
    grid-area: stack;
    min-width: 0;
}

.component-front {
    pointer-events: auto;
}

.component-back {
    display: none;
    gap: 0.75rem;
    min-height: 12rem;
    padding: 1rem;
    border: 1px solid transparent;
    border-radius: 18px;
    background: var(--surface-1);
    color: rgba(var(--fg), 0.92);
    box-shadow: var(--elev-3);
}

.component-back-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
}

.component-back h2 {
    margin: 0;
    font-size: 1rem;
    letter-spacing: -0.02em;
}

.component-back p {
    margin: 0;
    color: rgba(var(--fg), 0.58);
    font-size: 0.86rem;
    line-height: 1.35;
}

.component-back textarea {
    width: 100%;
    min-height: 10rem;
    resize: vertical;
    border: 1px solid transparent;
    border-radius: 14px;
    padding: 0.75rem;
    background: var(--surface-input);
    color: rgba(var(--fg), 0.92);
    font: inherit;
    line-height: 1.35;
}

.component-back textarea:focus {
    outline: none;
    border-color: transparent;
    background: var(--surface-input-focus);
}

.component-back-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: end;
    gap: 0.5rem;
    margin-top: 0.75rem;
}

.requirements-region { position: relative; }
.requirements-region-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
}
.requirements-region-overlay liquidos-callback { pointer-events: auto; }
.requirements-region-overlay [data-feature-loading] {
    color: rgba(var(--fg), 0.55);
    font-size: 0.9rem;
    letter-spacing: 0.02em;
}
.requirements-region-overlay [data-feature-loading][hidden] { display: none; }
.requirements-repair {
    padding: 0.5rem 0.9rem;
    font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
    text-transform: capitalize;
    letter-spacing: -0.005em;
    font-size: 0.82rem;
    font-weight: 600;
    border-radius: 6px;
    border: 1px solid transparent;
    background: var(--control);
    color: rgba(var(--fg), 0.95);
    cursor: pointer;
    box-shadow: none;
}
.requirements-repair:hover { background: var(--accent); color: var(--accent-fg); border-color: transparent; }

.component-back button,
.component-flip-button {
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 0.5rem 0.85rem;
    background: var(--control);
    color: rgba(var(--fg), 0.88);
    font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
    text-transform: capitalize;
    letter-spacing: -0.005em;
    font-size: 0.82rem;
    font-weight: 600;
}

.component-back button:hover:not(:disabled),
.component-flip-button:hover:not(:disabled) {
    background: var(--control-hover);
}

/* The Requirements (flip) button reads like the sidebar's Cancel button: a
   soft borderless --control fill on the white canvas, with dimmed text. */
.component-flip-button {
    background: var(--surface-1);   /* same fill as the Spaces / canvas Requirements toggles */
    padding: 0.45rem 0.9rem;
    border-color: rgba(var(--fg), 0.12);   /* very faint stroke */
    color: rgba(var(--fg), 0.7);
}
.component-flip-button:hover:not(:disabled) {
    background: var(--surface-1-hover);
}

.component-back button:disabled { opacity: 0.48; }

.component-save-button {
    background: var(--accent) !important;
    color: var(--accent-fg) !important;
}

.component-flip-button:focus-visible {
    outline: 2px solid var(--accent-border);
    outline-offset: 2px;
}

.component-chrome {
    grid-area: chrome;
    justify-self: end;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    /* System chrome sits just above the component, right-aligned. It lives in
       the component's own frame (the reserved "chrome" row), so it rides any
       transform the canvas applies (e.g. the gadgets 3D scene). The canvas
       overlay path lifts an identical element into #component-chrome-layer and
       drives top/left from script when a fold hides the frame (see
       updateComponentChrome). z-index keeps it above canvas paint. */
    position: relative;
    z-index: 2147483647;
    /* The reserved chrome row only takes space when the button is shown:
       max-height + margin collapse it to nothing when hidden, so there's no
       empty gap above each card in immersive mode. */
    max-height: 0;
    margin-top: 0;
    margin-bottom: 0;
    opacity: 0;
    visibility: hidden;
    transition: max-height 160ms ease, margin-top 160ms ease,
                margin-bottom 160ms ease, opacity 120ms ease,
                visibility 0s 160ms;
}

/* Meta controls ride with the prompt bar: when it's up (no data-prompt-hidden
   on <body>) every component shows its Requirements button; hiding the prompt
   bar (Escape) clears them all for a fully clean canvas. They also stay hidden
   while the canvas requirements panel is open (data-canvas-reqs-open) or the
   canvas grid is open (data-canvas-grid-open) — focused modes with every meta
   control out of the way. visibility (not just opacity) so a hidden button
   truly leaves the rendered tree, and the row's reserved space collapses with
   it. The data-needs-repair rule below still forces Repair visible regardless
   — an errored component must always be fixable. */
body:not([data-prompt-hidden="true"]):not([data-canvas-reqs-open="true"]):not([data-canvas-grid-open="true"]) .component-chrome {
    max-height: 3.5rem;
    margin-top: 0.7rem;
    margin-bottom: 0.7rem;
    opacity: 1;
    visibility: visible;
    transition: max-height 160ms ease, margin-top 160ms ease,
                margin-bottom 160ms ease, opacity 120ms ease;
}

/* When there's an unresolved runtime error, the Repair button stays
   visible without needing hover — the user needs to see it, and
   transient re-layouts (e.g., during a view.json re-render) shouldn't
   cause it to flicker out. */
liquidos-component[data-needs-repair="true"] .component-chrome {
    max-height: 3.5rem;
    margin-top: 0.7rem;
    margin-bottom: 0.7rem;
    opacity: 1;
    visibility: visible;
}

[data-runtime-repair-callback][hidden] { display: none; }
[data-runtime-repair-callback]:not([hidden]) { display: contents; }

.component-requirements-status {
    color: rgba(var(--fg), 0.58);
    font-size: 0.82rem;
}
.component-requirements-status:empty { display: none; }

.requirements-overlay .component-requirements-status { justify-self: end; }

.requirements-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: grid;
    place-items: center;
    padding: 2rem;
    background: var(--scrim);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
}

.requirements-overlay .item {
    width: min(1200px, calc(100vw - 3rem));
    min-width: 0;
}

.requirements-overlay .harness-component-frame-watcher {
    width: 100%;
    height: min(620px, calc(100vh - 4rem));
    display: grid;
    grid-template-columns: minmax(0, max-content) minmax(360px, 0.5fr);
    grid-template-rows: minmax(0, 1fr);
    grid-template-areas: none;
    column-gap: 1.5rem;
    justify-content: center;
}

.requirements-overlay .component-face {
    grid-area: auto;
    min-width: 0;
    min-height: 0;
    height: 100%;
    box-sizing: border-box;
    overflow: auto;
}

.requirements-overlay .component-back {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    padding: 1.25rem;
    overflow: hidden;
}

.requirements-overlay .component-chrome { display: none; }

.requirements-overlay .component-back textarea {
    min-height: 0;
    height: 100%;
    resize: none;
}

.requirements-overlay .surface {
    width: fit-content;
    max-width: 100%;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
}

.requirements-placeholder {
    min-height: 3rem;
    visibility: hidden;
    pointer-events: none;
}

@media (max-width: 900px) {
    .requirements-overlay .harness-component-frame-watcher {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(0, 1fr) minmax(240px, 0.5fr);
        column-gap: 0;
        row-gap: 1rem;
    }
}

liquidos-component { display: contents; }
`;

const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    document.head.appendChild(Object.assign(document.createElement('style'), {
        id: STYLE_ID, textContent: STYLE_TEXT
    }));
};

class LiquidOSComponent extends HTMLElement {
    constructor() {
        super();
        this.path = '';
        this.requirementsText = '';
        this.needsRepair = false;
        this.repairError = '';
        this._sseUnsubscribe = null;
        this._item = null;
        this._frame = null;
        this._chrome = null;
        this._front = null;
        this._back = null;
        this._surface = null;
        this._runtimeRepair = null;
        this._overlay = null;
        this._placeholder = null;
        this._initialized = false;
    }

    // Called by persistHostComponent on a clone of this element. Unwrap
    // the chrome buildShell may have wrapped around the authored content
    // — that chrome is a render artifact, not source — and drop the
    // morph-into hint that points at it.
    prepareForPersist() {
        this.removeAttribute('data-lc-morph-into');
        const frame = this.querySelector(':scope > section.item > div.harness-component-frame-watcher');
        if (!frame) return;
        const surface = frame.querySelector(':scope > div.component-face.component-front > div.surface');
        const authored = surface ? Array.from(surface.childNodes) : [];
        while (this.firstChild) this.removeChild(this.firstChild);
        for (const node of authored) this.appendChild(node);
    }

    connectedCallback() {
        if (this._initialized) return;
        this._initialized = true;
        this.path = String(this.getAttribute('path') || '').trim();
        // Scope (used for the agent callback) stays canvas-relative as the
        // agent wrote it. workspacePath is canvas-prefixed for fetching
        // requirements/diagnostics files.
        const canvas = window.liquidos?.canvasName;
        this.workspacePath = (canvas && this.path && !this.path.startsWith(canvas + '/'))
            ? canvas + '/' + this.path
            : this.path;
        // Nested chrome guard: when we're rendering inside the old
        // harness's component frame (.harness-component-frame-watcher
        // exists as an ancestor), the outer .item already provides the
        // chrome. Skip our own buildShell so the structure stays flat
        // and the user doesn't see two stacks of Requirements/Repair
        // buttons. Standalone usage (new-shape canvas, cssLayout, etc.)
        // has no such ancestor and gets the full shell as before.
        if (this.closest('.harness-component-frame-watcher')) {
            ensureStyle();
            return;
        }
        ensureStyle();
        this.buildShell();
        this.loadRequirements();
        this.loadDiagnostics();
        this.subscribeToWorkspace();
    }

    disconnectedCallback() {
        // Defer so DOM moves don't tear down. The modal's openModal moves
        // .item out of this element and back later — that should not look
        // like a permanent disconnect.
        queueMicrotask(() => {
            if (this.isConnected) return;
            if (this._sseUnsubscribe) { this._sseUnsubscribe(); this._sseUnsubscribe = null; }
            if (this._overlay) this.closeRequirementsOverlay({ skipMoveBack: true });
        });
    }

    // Build the same DOM the original harness rendered for each component:
    //
    //   <section class="item">
    //     <div class="harness-component-frame-watcher">
    //       <div class="component-chrome">
    //         <liquidos-callback data-runtime-repair-callback hidden>
    //           <button class="component-flip-button">Repair</button>
    //         </liquidos-callback>
    //         <button class="component-flip-button" data-component-flip>Requirements</button>
    //       </div>
    //       <div class="component-face component-front">
    //         <div class="surface">[the original children]</div>
    //       </div>
    //       <div class="component-face component-back">
    //         ... requirements form ...
    //       </div>
    //     </div>
    //   </section>
    buildShell() {
        const originalChildren = Array.from(this.childNodes);

        // Point the morph (lib/liquidos-elements/file.js) at .surface
        // so structural edits diff against the authored children and
        // leave the chrome we're about to build alone.
        this.dataset.lcMorphInto = '.surface';

        const item = document.createElement('section');
        item.className = 'item';
        item.dataset.componentPath = this.path;

        const frame = document.createElement('div');
        frame.className = 'harness-component-frame-watcher';

        const chrome = document.createElement('div');
        chrome.className = 'component-chrome';

        const runtimeRepair = document.createElement('liquidos-callback');
        runtimeRepair.setAttribute('on', 'click');
        runtimeRepair.setAttribute('scope', this.path);
        runtimeRepair.dataset.runtimeRepairCallback = 'true';
        runtimeRepair.hidden = true;
        runtimeRepair.innerHTML = '<button type="button" class="component-flip-button">Repair</button>';

        const flipButton = document.createElement('button');
        flipButton.type = 'button';
        flipButton.className = 'component-flip-button';
        flipButton.dataset.componentFlip = 'true';
        flipButton.textContent = 'Requirements';
        // Distinguish this component's Requirements button from every other
        // component's (and the canvas-level Requirements toggle) by naming the
        // component it edits. Starts from the prettified folder name; the real
        // title (view.json) refreshes it once features load (loadComponentFeatures).
        const flipLeaf = String(this.path || '').split('/').filter(Boolean).pop() || 'component';
        const flipName = flipLeaf.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        flipButton.setAttribute('aria-label', 'Edit ' + flipName + ' requirements');

        chrome.append(runtimeRepair, flipButton);

        const front = document.createElement('div');
        front.className = 'component-face component-front';
        const surface = document.createElement('div');
        surface.className = 'surface';
        for (const node of originalChildren) surface.appendChild(node);
        front.append(surface);

        const back = document.createElement('div');
        back.className = 'component-face component-back';
        back.innerHTML = [
            '<div class="component-back-header">',
            '<div>',
            '<h2 data-feature-title></h2>',
            '<p>Requirements</p>',
            '</div>',
            '<div class="share-toggle">',
            '<label class="share-toggle-label">Shared</label>',
            '<button type="button" data-component-share-switch class="share-switch" role="switch" aria-checked="false" aria-label="Toggle sharing for this component">',
            '<span class="share-switch-thumb"></span>',
            '</button>',
            '</div>',
            '</div>',
            '<div class="requirements-region">',
            '<textarea data-feature-requirements spellcheck="true" placeholder="Describe what this component should do, what it may use, and any limits it should respect."></textarea>',
            '<div class="requirements-region-overlay">',
            '<span data-feature-loading hidden>Loading…</span>',
            '<liquidos-callback on="click" data-feature-recover-callback hidden>',
            '<button type="button" data-feature-recover class="requirements-repair">Generate</button>',
            '</liquidos-callback>',
            '</div>',
            '</div>',
            '<div class="component-back-actions">',
            '<button type="button" data-feature-cancel>Close</button>',
            '<button type="button" class="component-save-button" data-feature-save disabled>Build</button>',
            '</div>',
            '<div class="component-requirements-status" data-feature-status aria-live="polite"></div>'
        ].join('');

        frame.append(chrome, front, back);
        item.append(frame);
        this.append(item);

        this._item = item;
        this._frame = frame;
        this._chrome = chrome;
        this._front = front;
        this._back = back;
        this._surface = surface;
        this._runtimeRepair = runtimeRepair;
        this._flipButton = flipButton;
        this._title = back.querySelector('[data-feature-title]');
        this._textarea = back.querySelector('[data-feature-requirements]');
        this._cancelButton = back.querySelector('[data-feature-cancel]');
        this._saveButton = back.querySelector('[data-feature-save]');
        this._recoverCallback = back.querySelector('[data-feature-recover-callback]');

        const titleFromPath = this.path.split('/').pop() || 'Component';
        this._title.textContent = titleFromPath.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        flipButton.addEventListener('click', e => {
            e.stopPropagation();
            if (this._overlay) this.closeRequirementsOverlay();
            else this.openRequirementsOverlay();
        });
        this._cancelButton.addEventListener('click', () => this.closeRequirementsOverlay());
        this._saveButton.addEventListener('click', () => this.saveRequirements());
        this._textarea.addEventListener('input', () => {
            this._saveButton.disabled = this._textarea.value === this.requirementsText;
        });

        // Per-component Share toggle. The harness owns the share state
        // logic (canvas cascade, opt-out semantics, server contract); we
        // just hand it our .item with the canvas-prefixed component path.
        const shareSwitch = back.querySelector('[data-component-share-switch]');
        if (shareSwitch) {
            shareSwitch.addEventListener('click', () => {
                this._item.__component = { componentPath: this.path };
                window.liquidos?.toggleComponentShareState?.(this._item);
            });
        }
    }

    requirementsPath() { return this.workspacePath + '/feature-requirements.txt'; }
    diagnosticsPath() { return this.workspacePath + '/diagnostics/status.json'; }

    async loadRequirements() {
        if (!this.path || !this._textarea) return;
        try {
            const r = await fetch('/workspace/' + this.requirementsPath());
            const fileExists = r.ok;
            const text = fileExists ? await r.text() : '';
            this.requirementsText = text;
            if (document.activeElement !== this._textarea) this._textarea.value = text;
            // Hide the loading indicator once the fetch completes.
            const loading = this._backEl?.querySelector('[data-feature-loading]');
            if (loading) loading.hidden = true;
            if (this._recoverCallback) {
                const empty = !text.trim();
                this._recoverCallback.hidden = !empty;
                if (empty) {
                    this._recoverCallback.setAttribute('scope', this.path);
                    // Missing → find-or-restore → Repair label. Present-but-
                    // empty → write-from-implementation → Generate label.
                    const label = fileExists ? 'Generate' : 'Repair';
                    const prompt = fileExists
                        ? 'Write feature-requirements.txt for ' + this.path + '. Describe what the component does in plain language, one requirement per line, each line a bullet beginning with "- ".'
                        : 'feature-requirements.txt is missing for ' + this.path + '. Find it (renamed or moved) or restore from git; only write a fresh one as a last resort from the implementation.';
                    this._recoverCallback.setAttribute('prompt', prompt);
                    const button = this._recoverCallback.querySelector('[data-feature-recover]');
                    if (button) button.textContent = label;
                }
            }
        } catch {}
    }

    async saveRequirements() {
        if (!this.path) return;
        const text = this._textarea?.value ?? '';
        // POST through /component/<scope>/features so the server writes
        // the file AND dispatches the agent to bring the implementation
        // back in sync. PUTting /workspace/ directly would save the text
        // but leave the component unchanged.
        await fetch('/component/' + encodeURIComponent(this.path) + '/features', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text })
        });
        this.requirementsText = text;
        this.closeRequirementsOverlay();
    }

    async loadDiagnostics() {
        if (!this.path) return;
        try {
            // /input is the source of truth — the server's needsRepair
            // already merges this component's own diagnostics with any
            // relationship where this component is the sender. We still
            // read our own diagnostic file as a secondary fetch to surface
            // a specific error message in the Repair prompt.
            const inputRes = await fetch('/input');
            if (inputRes.ok) {
                const snapshot = await inputRes.json();
                const all = [...(snapshot.components || []), ...(snapshot.relationships || [])];
                const entry = all.find(c => {
                    const scope = String(c.scope || '');
                    return scope === this.path || scope.endsWith('/' + this.path);
                });
                this.needsRepair = entry?.needsRepair === true;
            }
            const ownRes = await fetch('/workspace/' + this.diagnosticsPath());
            const ownData = ownRes.ok ? await ownRes.json() : null;
            const failed = Object.entries(ownData || {})
                .filter(([, v]) => v && typeof v === 'object' && v.ok === false);
            this.repairError = failed[0]?.[1]?.error || '';
            this.renderRepairChrome();
        } catch {}
    }

    renderRepairChrome() {
        if (!this._runtimeRepair) return;
        if (this.needsRepair) {
            this._runtimeRepair.hidden = false;
            this._runtimeRepair.setAttribute('prompt',
                'Repair required due to error: ' + (this.repairError || 'unknown error'));
            this.setAttribute('data-needs-repair', 'true');
        } else {
            this._runtimeRepair.hidden = true;
            this.removeAttribute('data-needs-repair');
        }
    }

    openRequirementsOverlay() {
        if (this._overlay) return;
        // Match the original: replace the .item with a placeholder, move
        // the .item into a fresh .requirements-overlay on body.
        const placeholder = document.createElement('div');
        placeholder.className = 'requirements-placeholder';
        this._placeholder = placeholder;
        this._item.replaceWith(placeholder);

        const overlay = document.createElement('div');
        overlay.className = 'requirements-overlay';
        overlay.append(this._item);
        document.body.append(overlay);
        this._overlay = overlay;
        if (this._flipButton) this._flipButton.textContent = 'Close';

        // Refresh per-component Share state on every open — the canvas
        // toggle may have flipped between views. Pass the canvas-relative
        // path; the harness's findAnyByPath matches that form too.
        this._item.__component = { componentPath: this.path };
        window.liquidos?.loadComponentShareState?.(this._item);

        overlay.addEventListener('click', e => {
            // Dismiss on any click outside the live component (.surface) and the
            // requirements panel (.component-back). The overlay centers a box
            // larger than what it paints, so the backdrop, the gap between the
            // two panes, and the empty area of the component's cell below its
            // surface all read as "outside".
            if (!e.target.closest('.surface, .component-back')) this.closeRequirementsOverlay();
        });
        document.addEventListener('keydown', this._onKey = e => {
            if (e.key === 'Escape') this.closeRequirementsOverlay();
        });
    }

    closeRequirementsOverlay({ skipMoveBack = false } = {}) {
        if (!this._overlay) return;
        if (!skipMoveBack && this._placeholder) {
            this._placeholder.replaceWith(this._item);
        }
        this._overlay.remove();
        this._overlay = null;
        this._placeholder = null;
        if (this._flipButton) this._flipButton.textContent = 'Requirements';
        if (this._onKey) {
            document.removeEventListener('keydown', this._onKey);
            this._onKey = null;
        }
    }

    subscribeToWorkspace() {
        const onEvent = window.liquidos?.onWorkspaceEvent;
        if (typeof onEvent !== 'function') return;
        // Match a relationship-diagnostic path where this component is the
        // sender (folder convention: "<sender>-to-<receiver>/diagnostics/
        // status.json"). The element doesn't enumerate relationships; it
        // pattern-matches the path the event reports.
        const myName = this.path.split('/').filter(Boolean).pop() || '';
        const relDiagRe = new RegExp('/relationships/' + myName + '-to-[^/]+/diagnostics/status\\.json$');
        this._sseUnsubscribe = onEvent(payload => {
            if (payload?.type !== 'workspace-file') return;
            if (payload.path === this.requirementsPath()) this.loadRequirements();
            else if (payload.path === this.diagnosticsPath()) this.loadDiagnostics();
            else if (myName && relDiagRe.test('/' + payload.path)) this.loadDiagnostics();
        });
    }
}

if (!customElements.get('liquidos-component')) {
    customElements.define('liquidos-component', LiquidOSComponent);
}

export { LiquidOSComponent };
