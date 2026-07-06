// A place() canvas that folds a card to a pill — a minimal stand-in for the
// woof canvas's "minimize" weather button. The whole point is the fold
// mechanism: collapsing an ANCESTOR of the harness-rendered item via
// opacity/max-height/overflow. If the harness still nested its system chrome
// (the Requirements button) inside the item, the fold would take it down too.
// This fixture exists to prove it doesn't — system chrome lives in the harness
// overlay and survives the fold.

export default (root) => {
    const style = document.createElement('style');
    style.textContent = `
        .crk-card { position: relative; display: inline-block; }
        .crk-card-body { display: inline-block; transition: opacity 120ms ease; }
        .crk-card.is-folded > .crk-card-body {
            max-height: 0;
            opacity: 0;
            overflow: hidden;
            pointer-events: none;
        }
        .crk-fold {
            position: absolute; top: 8px; left: 8px; z-index: 5;
            font: inherit; cursor: pointer;
        }
        .crk-pill { display: none; padding: 10px 16px; min-width: 200px; }
        .crk-card.is-folded .crk-pill { display: inline-flex; }
    `;
    root.appendChild(style);

    const wrappers = new Map();

    const wrap = item => {
        const path = item.dataset.componentPath || '';
        let card = wrappers.get(path);
        if (card) {
            card.querySelector(':scope > .crk-card-body').appendChild(item);
            return card;
        }
        card = document.createElement('div');
        card.className = 'crk-card';

        const fold = document.createElement('button');
        fold.type = 'button';
        fold.className = 'crk-fold';
        fold.textContent = 'Fold';
        fold.addEventListener('click', () => card.classList.toggle('is-folded'));

        const pill = document.createElement('div');
        pill.className = 'crk-pill';
        pill.textContent = 'FOLDED_PILL';

        const body = document.createElement('div');
        body.className = 'crk-card-body';
        body.appendChild(item);

        card.append(fold, pill, body);
        wrappers.set(path, card);
        return card;
    };

    return {
        place(items) {
            for (const item of items) root.appendChild(wrap(item));
        },
        teardown() {
            root.innerHTML = '';
            wrappers.clear();
        }
    };
};
