// Minimal wrapping presentation that mirrors the gadgets canvas pattern:
// each item is moved inside a per-item wrapper div in the canvas's own
// world element. teardown() wipes root via innerHTML='', so items in the
// detached subtree keep their parent links to the old wrappers.

export default (root) => {
    const style = document.createElement('style');
    style.textContent = `
        .test-world {
            position: fixed; inset: 0;
            display: grid; grid-auto-flow: column;
            gap: 32px; padding: 60px; place-items: center;
            background: #0f1117;
        }
        .test-card {
            min-width: 240px; min-height: 240px;
            display: grid; place-items: center;
            border: 4px solid #6ee7a1;
            border-radius: 18px;
            background: rgba(110, 231, 161, 0.12);
            color: #6ee7a1;
            font: 700 28px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
            box-shadow: 0 18px 50px rgba(110, 231, 161, 0.18);
        }
    `;
    root.appendChild(style);

    const world = document.createElement('div');
    world.className = 'test-world';
    root.appendChild(world);

    return {
        place(items) {
            const keptWraps = new Set();
            items.forEach(item => {
                let cardWrap = item.parentElement;
                const hasWrap = cardWrap && cardWrap.classList && cardWrap.classList.contains('test-card');
                if (!hasWrap) {
                    cardWrap = document.createElement('div');
                    cardWrap.className = 'test-card';
                    cardWrap.appendChild(item);
                    world.appendChild(cardWrap);
                }
                keptWraps.add(cardWrap);
            });
            Array.from(world.querySelectorAll('.test-card')).forEach(wrap => {
                if (!keptWraps.has(wrap)) wrap.remove();
            });
        },
        teardown() {
            root.innerHTML = '';
        }
    };
};
