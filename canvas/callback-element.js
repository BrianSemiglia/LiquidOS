class LiquidOSCallback extends HTMLElement {
    constructor() {
        super();
        this.handleDeclaredEvent = this.handleDeclaredEvent.bind(this);
        this.activeEventType = '';
        this.loading = false;
        LiquidOSCallback.ensureBusyStyle();
    }

    connectedCallback() {
        this.bindDeclaredEvent();
    }

    disconnectedCallback() {
        this.unbindDeclaredEvent();
    }

    static get observedAttributes() {
        return ['on'];
    }

    attributeChangedCallback() {
        this.bindDeclaredEvent();
    }

    bindDeclaredEvent() {
        const eventType = String(this.getAttribute('on') || '').trim();

        if (this.activeEventType === eventType) {
            return;
        }

        this.unbindDeclaredEvent();

        if (!eventType) {
            return;
        }

        this.activeEventType = eventType;
        this.addEventListener(eventType, this.handleDeclaredEvent);
    }

    unbindDeclaredEvent() {
        if (!this.activeEventType) {
            return;
        }

        this.removeEventListener(this.activeEventType, this.handleDeclaredEvent);
        this.activeEventType = '';
    }

    // Injected once. Pulses whatever the element wraps — any control, not a fixed list —
    // so the agent can wrap an arbitrary control and get an in-flight indicator for free.
    static ensureBusyStyle() {
        if (document.getElementById('liquidos-callback-busy-style')) {
            return;
        }

        document.head.appendChild(Object.assign(document.createElement('style'), {
            id: 'liquidos-callback-busy-style',
            textContent: `
@keyframes liquidos-callback-busy-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}

liquidos-callback[data-busy="true"] {
    cursor: progress;
}

/* Pulse the interactive controls the callback wraps (the same universal set the element
   treats as its controls). They always render a box, so this shows even when a wrapper in
   between is display:contents (e.g. .global-prompt > form). */
liquidos-callback[data-busy="true"] :is(button, a, input, textarea, select, [role="button"], [tabindex]) {
    animation: liquidos-callback-busy-pulse 1.3s ease-in-out infinite;
}
`
        }));
    }

    // While its request is in flight, mark the element busy (pulse whatever it wraps) and
    // make the whole subtree inert so it can't be re-invoked until the response — works for
    // any wrapped control, no control-type special-casing.
    setLoading(loading) {
        const next = Boolean(loading);

        if (this.loading === next) {
            return;
        }

        this.loading = next;

        if (next) {
            this.dataset.busy = 'true';
            this.setAttribute('aria-busy', 'true');
            this.inert = true;
        } else {
            delete this.dataset.busy;
            this.removeAttribute('aria-busy');
            this.inert = false;
        }
    }

    handleDeclaredEvent(event) {
        const scope = String(this.getAttribute('scope') || '').trim();
        const prompt = this.prompt();

        event.preventDefault();
        event.stopPropagation();

        if (!scope) {
            return;
        }

        // Cancelable so component-level handlers that call
        // preventDefault() actually flip defaultPrevented and suppress
        // the document-level catch-all. Without this, every callback
        // double-dispatches.
        this.dispatchEvent(new CustomEvent('liquidos:callback', {
            bubbles: true,
            composed: true,
            cancelable: true,
            detail: { scope, prompt }
        }));
    }

    prompt() {
        if (this.hasAttribute('prompt-from')) {
            return this.valueFor(String(this.getAttribute('prompt-from') || '').trim());
        }

        return this.renderPrompt(String(this.getAttribute('prompt') || '').trim());
    }

    renderPrompt(promptTemplate) {
        return this.valueNames().reduce(
            (prompt, name) => prompt.replaceAll('{{' + name + '}}', this.valueFor(name)),
            promptTemplate
        );
    }

    valueNames() {
        return String(this.getAttribute('values') || '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean);
    }

    valueFor(name) {
        // Read the value the way the wrapped form would submit it, so every control type is
        // handled by the browser (checked radio, checked checkboxes, selected option, typed
        // text) with no per-type logic. Falls back to a bare named control when there's no form.
        const form = this.querySelector('form');

        if (form) {
            const value = new FormData(form).get(name);
            return typeof value === 'string' ? value : '';
        }

        return String(this.querySelector('[name="' + CSS.escape(name) + '"]')?.value || '');
    }
}

if (!customElements.get('liquidos-callback')) {
    customElements.define('liquidos-callback', LiquidOSCallback);
}
