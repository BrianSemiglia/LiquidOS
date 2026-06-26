//
// probe-chat-composer.mjs
//
// The chat scaffolder (skills/chat/scripts/create-chat.sh) wires composer
// behaviors in chat.js that probe-chat.mjs doesn't exercise: Send stays inert
// until you type, sending echoes the user's own message into the log and clears
// the field, Enter sends, and Shift+Enter only inserts a newline. Drive each the
// way a user would and assert what ends up on screen (the rendered bubbles and
// the text in the field), never the DOM shape or the wire protocol.
//
// Run it:  node run-probe.mjs probe-chat-composer.mjs
//
// Self-managed sandbox (fixture = null): lays down its own workspace, runs the
// scaffolder, and boots with the deterministic chat-composer agent.
//

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootSandbox } from './sandbox.mjs';
import { CHAT_STUB_REPLY } from '../../../agent/test/chat-composer-agent.js';

export const fixture = null;

const COMPOSER = 'textarea[name="message"]';
const SEND = 'button[type="submit"]';

const onScreen = (page, text) => page.evaluate(t => visibleText().includes(t), text);
const waitForOnScreen = async (page, text, ms = 15000) => {
    try {
        await page.waitForFunction(t => visibleText().includes(t), text, { timeout: ms });
        return true;
    } catch {
        return false;
    }
};
// How many reply bubbles are on screen — one per successful send.
const replyCount = (page) => page.evaluate(t => {
    const text = visibleText();
    let n = 0, i = 0;
    while ((i = text.indexOf(t, i)) !== -1) { n++; i += t.length; }
    return n;
}, CHAT_STUB_REPLY);

export default async ({ browser }) => {
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    const appRoot = path.resolve(scriptsDir, '../../..');
    const createChat = path.join(appRoot, 'skills/chat/scripts/create-chat.sh');

    // A temp workspace with one empty canvas for the scaffolder to operate on.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-chat-composer-'));
    const ws = path.join(tmp, 'probe-chat-composer.liquidos');
    const canvasDir = path.join(ws, 'home');
    fs.mkdirSync(canvasDir, { recursive: true });
    fs.writeFileSync(path.join(canvasDir, 'index.json'), '{ "components": [] }\n');
    fs.writeFileSync(path.join(canvasDir, 'canvas.js'), "import { cssLayout } from '/lib/css-layout.js';\nexport default cssLayout('');\n");

    const scaffold = spawnSync('bash', [createChat, canvasDir], { encoding: 'utf8' });
    if (scaffold.status !== 0) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error('create-chat.sh exited ' + scaffold.status + '\nstderr: ' + scaffold.stderr);
    }

    const sandbox = await bootSandbox(ws, { agent: 'agent/test/chat-composer-agent.js' });
    try {
        const page = await browser.newPage();
        page.on('pageerror', err => console.log('[page error]', err.message));
        await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        if (!await waitForOnScreen(page, 'Chat with LiquidOS')) {
            throw new Error('the chat never rendered on screen');
        }

        // 1. Send is inert until you type: clicking the empty composer must not
        //    put a reply in the log. (force:true bypasses Playwright's "is it
        //    enabled?" gate so we observe the outcome, not the disabled attr.)
        await page.click(SEND, { force: true });
        await page.waitForTimeout(800);
        if (await replyCount(page) !== 0) {
            throw new Error('an empty composer sent a message — Send should be inert until you type');
        }
        console.log('  ok  Send is inert until you type');

        // 2. Enter sends, the field clears on send, and the user's own message
        //    plus a reply land in the log.
        const message = 'first message via enter';
        await page.fill(COMPOSER, message);
        await page.focus(COMPOSER);
        await page.keyboard.press('Enter');
        // Clears on send (not on reply): the field empties right away.
        try {
            await page.waitForFunction(sel => document.querySelector(sel).value === '', COMPOSER, { timeout: 5000 });
        } catch {
            const left = await page.$eval(COMPOSER, el => el.value);
            throw new Error('the composer did not clear on send (value: ' + JSON.stringify(left) + ')');
        }
        // The message is on screen because the chat echoed it — the field is empty.
        if (!await waitForOnScreen(page, message)) {
            throw new Error('the sent message was not echoed into the log');
        }
        if (!await waitForOnScreen(page, CHAT_STUB_REPLY)) {
            throw new Error('no reply landed after sending with Enter');
        }
        console.log('  ok  Enter sends, the field clears, and the message + reply land');

        // 3. Shift+Enter inserts a newline instead of sending: the draft grows a
        //    line and no new reply appears.
        const before = await replyCount(page);
        await page.fill(COMPOSER, 'line one');
        await page.focus(COMPOSER);
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        await page.keyboard.type('line two');
        await page.waitForTimeout(600);
        const draft = await page.$eval(COMPOSER, el => el.value);
        if (!draft.includes('\n')) {
            throw new Error('Shift+Enter did not insert a newline (field: ' + JSON.stringify(draft) + ')');
        }
        if (await replyCount(page) !== before) {
            throw new Error('Shift+Enter sent the message instead of inserting a newline');
        }
        console.log('  ok  Shift+Enter inserts a newline without sending');
    } finally {
        try { sandbox.teardown(); } catch {}
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
};
