class LiquidOSCallback extends HTMLElement {
    constructor() {
        super();
        this.handleDeclaredEvent = this.handleDeclaredEvent.bind(this);
        this.activeEventType = '';
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

    handleDeclaredEvent(event) {
        const scope = String(this.getAttribute('scope') || '').trim();
        const promptTemplate = String(this.getAttribute('prompt') || '').trim();

        if (!scope || !promptTemplate) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        this.dispatchEvent(new CustomEvent('liquidos:callback', {
            bubbles: true,
            composed: true,
            detail: {
                scope,
                prompt: this.renderPrompt(promptTemplate)
            }
        }));
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
        return String(this.querySelector('[name="' + CSS.escape(name) + '"]')?.value || '');
    }
}

if (!customElements.get('liquidos-callback')) {
    customElements.define('liquidos-callback', LiquidOSCallback);
}
