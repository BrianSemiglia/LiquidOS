// <liquidos-component> — standard chrome around a component's content.
//
//   <liquidos-component path="gadgets/components/audio-priority">
//     <!-- your component content -->
//   </liquidos-component>
//
// The DOM structure and CSS are copied verbatim from the original
// harness's component frame + requirements modal (see index.html).
// Nothing is reinterpreted. The element:
//   - watches <path>/presented/feature-requirements.txt for the modal's
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
    color: rgba(232, 232, 234, 0.72);
    letter-spacing: -0.005em;
}
.share-switch {
    position: relative;
    width: 36px;
    height: 20px;
    background: rgba(120, 120, 130, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 999px;
    padding: 0;
    cursor: pointer;
    transition: background 0.18s ease, border-color 0.18s ease;
    flex-shrink: 0;
}
.share-switch:hover { border-color: rgba(255, 255, 255, 0.14); }
.share-switch[aria-checked="true"] {
    background: rgba(59, 130, 246, 0.85);
    border-color: rgba(96, 165, 250, 0.5);
}
.share-switch-thumb {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 16px;
    height: 16px;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
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
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 18px;
    background: rgb(31, 41, 55);
    color: rgba(255, 255, 255, 0.92);
    box-shadow: 0 20px 70px rgba(0, 0, 0, 0.28);
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
    color: rgba(255, 255, 255, 0.58);
    font-size: 0.86rem;
    line-height: 1.35;
}

.component-back textarea {
    width: 100%;
    min-height: 10rem;
    resize: vertical;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 14px;
    padding: 0.75rem;
    background: rgb(43, 52, 65);
    color: rgba(255, 255, 255, 0.92);
    font: inherit;
    line-height: 1.35;
}

.component-back textarea:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.34);
    background: rgb(48, 57, 70);
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
    color: rgba(255, 255, 255, 0.55);
    font-size: 0.9rem;
    letter-spacing: 0.02em;
}
.requirements-region-overlay [data-feature-loading][hidden] { display: none; }
.requirements-repair {
    padding: 0.55rem 1rem;
    font: inherit;
    font-weight: 600;
    border-radius: 999px;
    border: 1px solid rgba(96, 165, 250, 0.45);
    background: rgba(30, 41, 59, 0.92);
    color: rgba(232, 232, 234, 0.95);
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.45);
}
.requirements-repair:hover { background: rgba(59, 130, 246, 0.9); border-color: rgba(96, 165, 250, 0.85); }

.component-back button,
.component-flip-button {
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 999px;
    padding: 0.45rem 0.75rem;
    background: rgba(255, 255, 255, 0.10);
    color: rgba(255, 255, 255, 0.88);
    font: inherit;
    font-size: 0.86rem;
    font-weight: 650;
}

.component-back button:hover:not(:disabled),
.component-flip-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.16);
}

.component-back button:disabled { opacity: 0.48; }

.component-save-button {
    background: rgba(255, 255, 255, 0.76) !important;
    color: rgba(17, 24, 39, 0.94) !important;
}

.component-flip-button:focus-visible {
    outline: 2px solid rgba(96, 165, 250, 0.65);
    outline-offset: 2px;
}

.component-chrome {
    grid-area: chrome;
    justify-self: end;
    margin-bottom: 0.4rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    opacity: 0;
    transition: opacity 120ms ease;
}

.harness-component-frame-watcher:hover .component-chrome,
.component-chrome:focus-within {
    opacity: 1;
}

/* When there's an unresolved runtime error, the Repair button stays
   visible without needing hover — the user needs to see it, and
   transient re-layouts (e.g., during a view.json re-render) shouldn't
   cause it to flicker out. */
liquidos-component[data-needs-repair="true"] .component-chrome {
    opacity: 1;
}

[data-runtime-repair-callback][hidden] { display: none; }
[data-runtime-repair-callback]:not([hidden]) { display: contents; }

.component-requirements-status {
    color: rgba(255, 255, 255, 0.58);
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
    background: rgba(3, 7, 18, 0.82);
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
    grid-template-columns: minmax(0, 1fr) minmax(360px, 0.5fr);
    grid-template-rows: minmax(0, 1fr);
    grid-template-areas: none;
    column-gap: 1.5rem;
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
            '<button type="button" data-feature-cancel>Cancel</button>',
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
                        ? 'Write feature-requirements.txt for ' + this.path + '. Describe what the component does in plain language, one requirement per line.'
                        : 'feature-requirements.txt is missing for ' + this.path + '. Find it (renamed, moved, in .presented/) or restore from git; only write a fresh one as a last resort from the implementation.';
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
            const r = await fetch('/workspace/' + this.diagnosticsPath());
            const data = r.ok ? await r.json() : null;
            const failed = Object.entries(data || {})
                .filter(([, v]) => v && typeof v === 'object' && v.ok === false);
            this.needsRepair = failed.length > 0;
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

        overlay.addEventListener('click', e => {
            if (e.target === overlay) this.closeRequirementsOverlay();
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
        this._sseUnsubscribe = onEvent(payload => {
            if (payload?.type !== 'workspace-file') return;
            if (payload.path === this.requirementsPath()) this.loadRequirements();
            else if (payload.path === this.diagnosticsPath()) this.loadDiagnostics();
        });
    }
}

if (!customElements.get('liquidos-component')) {
    customElements.define('liquidos-component', LiquidOSComponent);
}

export { LiquidOSComponent };
