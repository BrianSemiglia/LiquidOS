//
// probe-canvas-teardown-rewrap
//
// When canvas.js is edited mid-session, the harness must re-instantiate
// the presentation: it calls currentCanvas.teardown() (which typically
// runs root.innerHTML = '') and then the new canvas's place(items, ...).
// The items handed to place() are the same DOM nodes the previous canvas
// had — they're still pinned to their old per-item wrappers, which are
// now sitting in a detached subtree. A canvas that uses the standard
// "if my wrapper is already this item's parent, reuse it" pattern will
// keep the detached wrappers and the items never reach the new world.
//
// This probe boots a fixture whose canvas wraps items in `.test-card`
// inside a `.test-world`, asserts the items are visible, edits canvas.js
// to force a teardown + re-place, and asserts the items are STILL inside
// the new world. Without the harness contract fix, the second assertion
// fails (items remain in detached old wrappers).
//
// Run it:  node run-probe.mjs probe-canvas-teardown-rewrap
//

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

export const fixture = './workspace.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.test-world', { timeout: 20000 });
    await page.waitForFunction(
        () => document.querySelectorAll('.test-world .test-card').length === 2,
        { timeout: 10000 }
    );

    const before = await page.evaluate(() => ({
        wrapsInWorld: document.querySelectorAll('.test-world > .test-card').length,
        alphaInWorld: !!document.querySelector('.test-world [data-test-card-alpha]'),
        betaInWorld: !!document.querySelector('.test-world [data-test-card-beta]')
    }));
    console.log('before edit:', before);

    // Edit canvas.js — appending a trivial comment bumps mtime, which
    // changes canvasJsVersion in /input. The client re-imports canvas.js,
    // tears down the old instance, instantiates the new one, and calls
    // its place() with the same items.
    const canvasJsPath = path.join(workspace, 'home', 'canvas.js');
    fs.writeFileSync(canvasJsPath, fs.readFileSync(canvasJsPath, 'utf8') + '\n// probe bump ' + Date.now() + '\n');
    console.log('--- edited canvas.js ---');

    // Give the re-instantiation a moment to settle.
    await sleep(1500);

    const after = await page.evaluate(() => ({
        wrapsInWorld: document.querySelectorAll('.test-world > .test-card').length,
        alphaInWorld: !!document.querySelector('.test-world [data-test-card-alpha]'),
        betaInWorld: !!document.querySelector('.test-world [data-test-card-beta]'),
        worldExists: !!document.querySelector('.test-world')
    }));
    console.log('after edit:', after);

    if (!after.worldExists) {
        throw new Error('.test-world missing after canvas.js edit (new canvas did not mount)');
    }
    if (after.wrapsInWorld !== 2) {
        throw new Error('expected 2 .test-card wraps inside new .test-world, got ' + after.wrapsInWorld);
    }
    // Both components must have re-placed INTO the new world, not been stranded
    // in the previous canvas's now-detached wrappers.
    if (!after.alphaInWorld || !after.betaInWorld) {
        throw new Error('a component did not reach the new world (alpha=' + after.alphaInWorld + ', beta=' + after.betaInWorld + ')');
    }
};
