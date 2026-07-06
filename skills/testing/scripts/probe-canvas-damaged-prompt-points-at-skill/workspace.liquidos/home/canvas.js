// A custom canvas with place() that paints its own decorative DOM
// (representing the foo7 "rain overlay" case). When the canvas is
// flagged broken, this overlay must be torn down too — leaving it
// next to the Repair card would be confusing noise.
export default (root) => {
    const overlay = document.createElement('div');
    overlay.dataset.canvasOverlay = 'rain';
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    overlay.textContent = 'rain-overlay';
    root.appendChild(overlay);

    return {
        place(items) {
            // Keep the overlay; drop everything else and re-add the items.
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
