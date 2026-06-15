//
// probe-canvas-stage-injection.mjs
//
// A component may paint OUTSIDE its own card — into DOM owned by canvas.js.
// The forest does exactly this: its functions.js injects a full-screen WebGL
// backdrop into the room stage. When canvas.js is edited mid-session the
// harness re-imports it, runs the old canvas's teardown() (which wipes the
// canvas-owned DOM, backdrop included) and mounts the new one. If the harness
// only re-places the reused card items, the component's mount never re-runs,
// so the backdrop is gone until the user switches canvases and back.
//
// This probe boots a fixture whose canvas owns a `.probe-room-stage` and whose
// `backdrop` component injects a full-screen node reading "BACKDROP LIVE" into
// that stage. It asserts the text is on screen, edits canvas.js to force a
// teardown + re-mount, and asserts "BACKDROP LIVE" is on screen AGAIN. Without
// the harness re-mounting components on a canvas reload, the second assertion
// fails — the backdrop was destroyed with the stage and never rebuilt.
//
// Run it:  node run-probe.mjs probe-canvas-stage-injection.mjs
//

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

export const fixture = 'canvas-stage-injection.liquidos';

// Resolve once an element carrying `text` is rendered and visible (has a
// non-empty box and isn't display:none / visibility:hidden) — i.e. actually
// on screen, the only thing this probe cares about.
const waitForVisibleText = (page, text, timeout) =>
    page.waitForFunction(
        wanted => {
            const els = Array.from(document.querySelectorAll('body *'));
            return els.some(el => {
                if (!el.textContent || !el.textContent.includes(wanted)) return false;
                const style = getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        },
        text,
        { timeout }
    );

export default async ({ url, workspace, page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // The card paints inside its own surface; the backdrop paints into the
    // canvas-owned stage; the canvas shows its build label. All on screen
    // before we touch canvas.js.
    await waitForVisibleText(page, 'canvas build alpha', 20000);
    await waitForVisibleText(page, 'CARD', 15000);
    await waitForVisibleText(page, 'BACKDROP LIVE', 15000);
    console.log('before edit: build alpha + CARD + BACKDROP LIVE on screen');

    // Edit canvas.js by changing its visible build label (alpha → bravo). This
    // bumps canvasJsVersion (the client re-imports canvas.js, tears the old
    // instance down — wiping the stage + injected backdrop — and mounts the
    // new one) AND gives an on-screen signal that the new canvas has mounted,
    // so we don't race the /input poll and assert against the old stage's
    // still-present backdrop.
    const canvasJsPath = path.join(workspace, 'home', 'canvas.js');
    fs.writeFileSync(canvasJsPath, fs.readFileSync(canvasJsPath, 'utf8').replace('canvas build alpha', 'canvas build bravo'));
    console.log('--- edited canvas.js (build bravo) ---');

    // Wait until the new canvas is on screen (its bravo label).
    await waitForVisibleText(page, 'canvas build bravo', 15000)
        .catch(() => { throw new Error('canvas.js did not reload (build bravo never appeared)'); });
    console.log('--- canvas.js reloaded (build bravo on screen) ---');

    // The card is re-placed into the new stage by the canvas itself; assert it
    // survived so a regression here can't be mistaken for the backdrop bug.
    try {
        await waitForVisibleText(page, 'CARD', 10000);
    } catch {
        throw new Error('CARD vanished after canvas.js edit — re-placement regressed');
    }

    // The backdrop lived in the wiped stage. It only comes back if the harness
    // re-mounts the component so its functions.js re-injects into the new
    // stage. This is the assertion the fix exists for.
    try {
        await waitForVisibleText(page, 'BACKDROP LIVE', 10000);
    } catch {
        throw new Error(
            'BACKDROP LIVE did not return after canvas.js reload — the component ' +
            'that injects into canvas-owned DOM was not re-mounted'
        );
    }
    console.log('after edit: BACKDROP LIVE re-injected into the rebuilt stage');
};
