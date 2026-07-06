// Minimal canvas: just attach each component item to a container. Enough to
// render components (their entry <liquidos-file> + scripts) so the
// probe can exercise the script re-mount path.
export default (root) => {
    const world = document.createElement('div');
    root.appendChild(world);
    return {
        place(items) {
            items.forEach(item => { if (item.parentElement !== world) world.appendChild(item); });
        },
        teardown() { root.innerHTML = ''; },
    };
};
