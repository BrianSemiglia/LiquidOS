// Script-mode component: paints a value that lives in a sibling module it
// imports (./greeting.js), plus an on-screen mount number so a re-run is
// visible. Editing greeting.js must re-run this; editing unused.js must not.
import { GREETING } from './greeting.js';

export const mount = (surface) => {
    const node = document.createElement('div');
    node.setAttribute('data-role', 'greeting');
    node.textContent = GREETING + ' #' + (window.__greetMounts = (window.__greetMounts || 0) + 1);
    surface.appendChild(node);
    return () => node.remove();
};
