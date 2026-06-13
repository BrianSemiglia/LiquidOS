#!/usr/bin/env node
//
// probe-lqpatch-stream-component-edit.mjs
//
// The user prompts; the agent builds; the thing the user asked for shows up
// on screen and is still there after a reload.
//
// This asserts only what a person looking at the app would see: a unique
// string, rendered as visible text. It does not read the app's internals
// (no window.__lqpatch), does not inspect HTML structure, and does not read
// files off disk. That's deliberate — the protocol, the op names, how a
// patch is framed, where it persists, are all private and free to change.
// The test stays the source of truth because it only knows what the screen
// shows.
//
// Wire it exercises: prompt bar -> harness queue -> agent -> patches ->
// rendered DOM -> persisted across reload. If any link breaks, the string
// the user asked for is not on screen and the assertion fails.
//

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '../../..');
const fixture = path.join(scriptsDir, '..', 'fixtures', 'agent-edit-stub.liquidos');

const launcher = spawn('node', [
    path.join(scriptsDir, 'boot-workspace-sandbox.mjs'),
    '--workspace', fixture,
    '--app', appRoot,
    '--agent', 'lqpatch-stream-stub'
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sandbox = await new Promise((resolve, reject) => {
    let buf = '';
    const onExit = () => reject(new Error('sandbox launcher exited before printing url'));
    launcher.on('exit', onExit);
    launcher.stdout.on('data', chunk => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
            launcher.off('exit', onExit);
            try { resolve(JSON.parse(buf.slice(0, nl))); }
            catch (e) { reject(new Error('non-json launcher output: ' + buf.slice(0, 200))); }
        }
    });
    launcher.stderr.on('data', c => process.stderr.write('[launcher] ' + c.toString('utf8')));
});

const cleanup = () => { try { launcher.kill('SIGTERM'); } catch {} };
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

// Is this string visible to a person looking at the page? innerText is the
// rendered, visible text — it skips hidden nodes, <style>, <script>.
const onScreen = (page, text) =>
    page.evaluate(t => document.body.innerText.includes(t), text);

let exitCode = 0;
try {
    const token = 'TOK_' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const wanted = 'PERSISTED_' + token; // the unique string the agent will render

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    expect('the string is not on screen before the prompt',
        !(await onScreen(page, wanted)),
        'the page already showed it — the test would prove nothing');

    // Drive the prompt bar, the way the user does.
    await page.waitForSelector('#global-text', { timeout: 15000 });
    await page.locator('#global-text').fill('REPLACE_WITH: ' + token);
    await page.evaluate(() => document.getElementById('global-prompt').requestSubmit());

    // The agent builds; the thing the user asked for appears on screen.
    await page.waitForFunction(
        t => document.body.innerText.includes(t), wanted, { timeout: 30000 }
    ).catch(() => {});
    expect('what the user asked for is on screen after the agent runs',
        await onScreen(page, wanted),
        'never saw "' + wanted + '" in the visible page');

    // It survives a reload — the build was persisted, not just painted.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
        t => document.body.innerText.includes(t), wanted, { timeout: 15000 }
    ).catch(() => {});
    expect('it is still on screen after a reload',
        await onScreen(page, wanted),
        '"' + wanted + '" disappeared on reload — the build was not persisted');

    console.log('PASS');
    await browser.close();
} catch (e) {
    console.error(e.message);
    exitCode = 1;
} finally {
    cleanup();
    process.exit(exitCode);
}
