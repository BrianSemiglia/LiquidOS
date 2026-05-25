class LiquidOSCallback extends HTMLElement {
    constructor() {
        super();
        this.handleDeclaredEvent = this.handleDeclaredEvent.bind(this);
        this.activeEventType = '';
        this.loading = false;
        this.originalControls = [];
        this.loadingTargets = [];
        this.lastTrigger = null;
        LiquidOSCallback.ensureSpinnerStyle();
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

    static ensureSpinnerStyle() {
        if (document.getElementById('liquidos-callback-spinner-style')) {
            return;
        }

        document.head.appendChild(Object.assign(document.createElement('style'), {
            id: 'liquidos-callback-spinner-style',
            textContent: `
liquidos-callback [data-liquidos-callback-loading="true"] {
    cursor: progress !important;
}

liquidos-callback .liquidos-callback-spinner {
    display: inline-block;
    width: 1em;
    height: 1em;
    margin-inline-start: .5em;
    border-radius: 999px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    animation: liquidos-callback-spin .7s linear infinite;
    pointer-events: none;
    vertical-align: -.15em;
    flex: 0 0 auto;
}

@keyframes liquidos-callback-spin {
    to { transform: rotate(360deg); }
}
`
        }));
    }

    setLoading(loading) {
        if (loading) {
            this.startLoading();
            return;
        }

        this.stopLoading();
    }

    startLoading() {
        if (this.loading) {
            return;
        }

        this.loading = true;
        this.loadingTargets = this.targets();
        this.originalControls = this.loadingTargets.map(target => ({
            target,
            disabled: 'disabled' in target ? target.disabled : null,
            ariaBusy: target.getAttribute('aria-busy'),
            pointerEvents: target.style.pointerEvents,
            spinner: this.spinnerFor(target)
        }));

        this.originalControls.forEach(({ target, spinner }) => {
            if ('disabled' in target) {
                target.disabled = true;
            } else {
                target.style.pointerEvents = 'none';
            }

            target.setAttribute('aria-busy', 'true');
            target.dataset.liquidosCallbackLoading = 'true';
            this.placeSpinner(target, spinner);
        });
    }

    stopLoading() {
        if (!this.loading) {
            return;
        }

        this.originalControls.forEach(({ target, disabled, ariaBusy, pointerEvents, spinner }) => {
            if ('disabled' in target) {
                target.disabled = disabled;
            } else {
                target.style.pointerEvents = pointerEvents;
            }

            spinner.remove();
            delete target.dataset.liquidosCallbackLoading;

            if (ariaBusy === null) {
                target.removeAttribute('aria-busy');
                return;
            }

            target.setAttribute('aria-busy', ariaBusy);
        });

        this.originalControls = [];
        this.loadingTargets = [];
        this.loading = false;
    }

    targets() {
        if (this.lastTrigger && this.contains(this.lastTrigger)) {
            return [this.lastTrigger];
        }

        const controls = Array.from(this.querySelectorAll('button, a, input, textarea, select, [role="button"], [tabindex]'))
            .filter(control => !['hidden'].includes(String(control.type || '').toLowerCase()));

        return controls.length ? controls : [this];
    }

    triggerElement(event) {
        if (event.submitter instanceof Element) {
            return event.submitter;
        }

        if (!(event.target instanceof Element)) {
            return null;
        }

        return event.target.closest('button, a, input, textarea, select, [role="button"], [tabindex]') || event.target;
    }

    spinnerFor() {
        return Object.assign(document.createElement('span'), {
            className: 'liquidos-callback-spinner',
            ariaHidden: 'true'
        });
    }

    placeSpinner(target, spinner) {
        if (this.canContainSpinner(target)) {
            target.appendChild(spinner);
            return;
        }

        target.after(spinner);
    }

    canContainSpinner(target) {
        return !['INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'BR', 'HR'].includes(target.tagName);
    }

    handleDeclaredEvent(event) {
        const scope = String(this.getAttribute('scope') || '').trim();
        const prompt = this.prompt();

        event.preventDefault();
        event.stopPropagation();
        this.lastTrigger = this.triggerElement(event);

        if (!scope) {
            return;
        }

        this.dispatchEvent(new CustomEvent('liquidos:callback', {
            bubbles: true,
            composed: true,
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
        return String(this.querySelector('[name="' + CSS.escape(name) + '"]')?.value || '');
    }
}

if (!customElements.get('liquidos-callback')) {
    customElements.define('liquidos-callback', LiquidOSCallback);
}
