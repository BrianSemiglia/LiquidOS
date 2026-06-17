// Default stack presentation: components laid out top-to-bottom by CSS.
// Delegates to the shared cssLayout helper — the harness has no special
// path for CSS; it's just one composition pattern that this file picks.

import { cssLayout } from '/lib/css-layout.js';

export default cssLayout(`
/* The harness owns the frame (.canvas-shell): position, scroll, and the
   step-back inset. A canvas only adds its content padding here and styles
   #app + its items — never re-position the frame or anchor to the window. */
.canvas-shell {
    padding: 2rem 2rem 2rem 1rem;
}

#app {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    align-items: flex-start;
    width: 100%;
    min-height: calc(100vh - 4rem);
}

.item {
    position: relative;
    display: inline-block;
    width: auto;
    max-width: 100%;
    min-width: 0;
    border-radius: 10px;
    outline: 2px solid transparent;
    outline-offset: 4px;
}

.surface {
    display: inline-block;
    width: auto;
    max-width: 100%;
    min-width: 0;
    overflow: visible;
    vertical-align: top;
}

.status {
    min-height: 1.25rem;
    color: #93c5fd;
    font-size: 0.85rem;
}

.error {
    color: #fecaca;
}

@media (max-width: 1100px) {
    .canvas-shell {
        padding: 2rem 1rem;
    }
}
`);
