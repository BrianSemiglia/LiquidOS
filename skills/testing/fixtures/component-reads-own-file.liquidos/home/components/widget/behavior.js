// Reads the component's own data file with a canvas-relative path — the same
// path form used in markup — via the harness helper.
export const mount = async (surface) => {
    const out = surface.querySelector('[data-out]');
    const data = await window.liquidos.fetchJson('components/widget/data/value.json');
    out.textContent = data ? data.value : 'NO_DATA';
};
