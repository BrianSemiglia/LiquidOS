//
// probe-chat.mjs
//
// The chat skill: scaffold a chat with skills/chat/scripts/create-chat.sh, then
// prove it works the way a user would use it — the chat shows up, you type a
// message, hit the "↑" Send button, and your message plus a reply land in the log.
//
// The chat echoes the user's own message into the log on send; a deterministic
// chat-stub agent stands in for the real one and appends only its .msg--bot
// reply. The probe asserts only what's on screen (the rendered text), never the
// DOM shape, the wire protocol, or files on disk.
//
// Run it:  node run-probe.mjs probe-chat.mjs
//
// Self-managed sandbox (fixture = null): the probe lays down its own workspace,
// runs the scaffolder, and boots the sandbox itself.
//

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootSandbox } from './sandbox.mjs';
import { CHAT_STUB_REPLY } from '../../../agent/test/chat-stub-agent.js';

export const fixture = null;

const onScreen = (page, text) => page.evaluate(t => visibleText().includes(t), text);
const waitForOnScreen = async (page, text, ms = 15000) => {
    try {
        await page.waitForFunction(t => visibleText().includes(t), text, { timeout: ms });
        return true;
    } catch {
        return false;
    }
};

export default async ({ browser }) => {
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    const appRoot = path.resolve(scriptsDir, '../../..');
    const createChat = path.join(appRoot, 'skills/chat/scripts/create-chat.sh');

    // A temp workspace with one empty canvas for the scaffolder to operate on.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-chat-'));
    const ws = path.join(tmp, 'probe-chat.liquidos');
    const canvasDir = path.join(ws, 'home');
    fs.mkdirSync(canvasDir, { recursive: true });
    fs.writeFileSync(path.join(canvasDir, 'index.json'), '{ "components": [] }\n');
    fs.writeFileSync(path.join(canvasDir, 'canvas.js'), "import { cssLayout } from '/lib/css-layout.js';\nexport default cssLayout('');\n");

    const scaffold = spawnSync('bash', [createChat, canvasDir], { encoding: 'utf8' });
    if (scaffold.status !== 0) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error('create-chat.sh exited ' + scaffold.status + '\nstderr: ' + scaffold.stderr);
    }

    const sandbox = await bootSandbox(ws, { agent: 'agent/test/chat-stub-agent.js' });
    try {
        const page = await browser.newPage();
        page.on('pageerror', err => console.log('[page error]', err.message));
        await page.goto(sandbox.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // 1. The scaffolded chat shows up.
        if (!await waitForOnScreen(page, 'Chat with LiquidOS')) {
            throw new Error('the chat never rendered on screen');
        }
        // The composer's Send control is a glyph button ("↑", aria-label "Send").
        if (!await onScreen(page, '↑')) {
            throw new Error('the chat composer ("↑" Send) is not on screen');
        }
        console.log('  ok  create-chat.sh puts a working chat on screen');

        // 2. Drive it like a user: type a message and send it. The composer is
        // a <textarea name="message"> (it grows with content, like the prompt
        // bar), not an <input>.
        const message = 'hello from the probe';
        await page.fill('textarea[name="message"]', message);
        await page.click('button[type="submit"]');

        // 3. The user's message and a reply land in the log.
        if (!await waitForOnScreen(page, message)) {
            throw new Error('the sent message never appeared in the chat log');
        }
        if (!await waitForOnScreen(page, CHAT_STUB_REPLY)) {
            throw new Error('the reply never appeared in the chat log');
        }
        console.log('  ok  sending a message shows the message and a reply in the log');

        // 4. Both survive a reload. The chat echoes the user's bubble straight
        //    into the DOM on send; this proves it actually persisted (carried
        //    into component.html when the agent's reply op landed), not just
        //    painted for the session.
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!await waitForOnScreen(page, message)) {
            throw new Error('the user message did not survive a reload (not persisted)');
        }
        if (!await waitForOnScreen(page, CHAT_STUB_REPLY)) {
            throw new Error('the reply did not survive a reload (not persisted)');
        }
        console.log('  ok  the conversation survives a reload');
    } finally {
        try { sandbox.teardown(); } catch {}
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
};
