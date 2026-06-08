// <liquidos-callback> — wraps a control, dispatches a `liquidos:callback`
// CustomEvent on the declared `on=` event with { scope, prompt }. The host
// (index.html) listens for the event and POSTs /callback. `setLoading`
// pulses and disables the wrapped control while the request is in flight.

class LiquidOSCallback extends HTMLElement {
    constructor() {
        super();
        this.handleDeclaredEvent = this.handleDeclaredEvent.bind(this);
        this.activeEventType = '';
        this.loading = false;
        LiquidOSCallback.ensureBusyStyle();
    }

    connectedCallback() { this.bindDeclaredEvent(); }
    disconnectedCallback() { this.unbindDeclaredEvent(); }

    static get observedAttributes() { return ['on']; }
    attributeChangedCallback() { this.bindDeclaredEvent(); }

    bindDeclaredEvent() {
        const eventType = String(this.getAttribute('on') || '').trim();
        if (this.activeEventType === eventType) return;
        this.unbindDeclaredEvent();
        if (!eventType) return;
        this.activeEventType = eventType;
        this.addEventListener(eventType, this.handleDeclaredEvent);
    }

    unbindDeclaredEvent() {
        if (!this.activeEventType) return;
        this.removeEventListener(this.activeEventType, this.handleDeclaredEvent);
        this.activeEventType = '';
    }

    static ensureBusyStyle() {
        if (document.getElementById('liquidos-callback-busy-style')) return;
        document.head.appendChild(Object.assign(document.createElement('style'), {
            id: 'liquidos-callback-busy-style',
            textContent: `
@keyframes liquidos-callback-busy-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
liquidos-callback[data-busy="true"] { cursor: progress; }
liquidos-callback[data-busy="true"] :is(button, a, input, textarea, select, [role="button"], [tabindex]) {
    animation: liquidos-callback-busy-pulse 1.3s ease-in-out infinite;
}
`
        }));
    }

    setLoading(loading) {
        const next = Boolean(loading);
        if (this.loading === next) return;
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
        if (!scope) return;
        this.dispatchEvent(new CustomEvent('liquidos:callback', {
            bubbles: true,
            composed: true,
            detail: { scope, prompt, element: this }
        }));
    }

    prompt() {
        if (this.hasAttribute('prompt-from')) {
            return this.valueFor(String(this.getAttribute('prompt-from') || '').trim());
        }
        return this.renderPrompt(String(this.getAttribute('prompt') || '').trim());
    }

    renderPrompt(template) {
        return this.valueNames().reduce(
            (s, name) => s.replaceAll('{{' + name + '}}', this.valueFor(name)),
            template
        );
    }

    valueNames() {
        return String(this.getAttribute('values') || '')
            .split(',').map(v => v.trim()).filter(Boolean);
    }

    valueFor(name) {
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

export { LiquidOSCallback };
