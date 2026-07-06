// Forwards button presses to the sink with a label that lives in a sibling
// module it imports. Editing label.js must re-wire this with the new label —
// the relationship's dependency, not its entry file.
import { LABEL } from './label.js';

export const mount = (surface) => {
    let off = null;
    surface.__io = {
        peers: ['source', 'sink'],
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const src = peers['source'];
            const dst = peers['sink'];
            if (!src || !dst) return;
            off = src.on('press', () => dst.send('show', LABEL));
        },
    };
    return () => { if (off) { try { off(); } catch {} ; off = null; } };
};
