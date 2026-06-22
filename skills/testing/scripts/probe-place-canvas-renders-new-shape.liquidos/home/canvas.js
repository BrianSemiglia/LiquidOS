// Old-shape canvas: defines place(items, components) and paints its own
// decorative DOM (overlay) — mirrors the woof canvas shape from
// foo7. The point of this fixture: when an old-shape place() canvas
// references a new-shape component (component.html entry), the
// component must still render inside the items the canvas places.

export default (root) => {
    const overlay = document.createElement('div');
    overlay.dataset.canvasOverlay = 'rain';
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    overlay.textContent = 'overlay';
    root.appendChild(overlay);

    return {
        place(items) {
            for (const child of Array.from(root.children)) {
                if (child !== overlay) child.remove();
            }
            for (const item of items) root.appendChild(item);
        },
        teardown() {
            overlay.remove();
        }
    };
};
