// A canvas with a NAMED STREAMABLE REGION alongside its component cards. The
// region is a render-mode <liquidos-file stream-surface> backed by
// regions/hero.html; the agent streams into selectors inside it and the client
// persists to that file (not to any component.html).
export default function canvas(root) {
    const region = document.createElement('section');
    region.className = 'item';
    region.innerHTML = '<liquidos-file path="regions/hero.html" stream-surface></liquidos-file>';
    return {
        place(items) {
            root.replaceChildren(region, ...items);
        },
        teardown() { root.innerHTML = ''; }
    };
}
