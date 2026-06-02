import { cssLayout } from '/lib/css-layout.js';

export default cssLayout(`
.canvas-shell { position: fixed; inset: 0; left: var(--debug-rail-space); overflow: auto; padding: 2rem; }
#app { display: flex; flex-direction: column; gap: 1rem; }
.item { padding: 1rem; border-radius: 8px; background: rgba(255,255,255,0.06); }
`);
