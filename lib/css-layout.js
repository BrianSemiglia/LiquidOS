//
// cssLayout(cssString) -> presentation factory.
//
// The factory applies the stylesheet to <head> and places the harness-given
// cards as direct children of the canvas root. It does not touch the cards'
// inline styles — the harness resets those on presentation swap, so each
// presentation starts from clean items and is free to add its own inline
// positioning if needed.
//

export const cssLayout = (cssText) => (root) => {
    const style = document.createElement('style');
    style.textContent = cssText;
    document.head.appendChild(style);
    return {
        place(items) {
            root.replaceChildren(...items);
        },
        teardown() {
            style.remove();
        }
    };
};
