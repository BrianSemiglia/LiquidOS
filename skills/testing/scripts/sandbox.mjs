//
// sandbox.mjs — boot a LiquidOS sandbox by driving boot-workspace-sandbox.mjs.
//
// One shared boot path: run-probe.mjs uses it for each probe's primary
// sandbox, and a probe that needs extra peers (cross-peer, install-from-peer)
// imports `bootSandbox` to bring them up and tears them down in a `finally`.
//
//   import { bootSandbox } from './sandbox.mjs';
//   const peer = await bootSandbox('canvas-build.liquidos', { agent: 'none' });
//   try { /* drive peer.url / peer.workspace */ } finally { peer.teardown(); }
//
// teardown SIGTERMs the launcher, whose own handler tears the server down
// (SIGKILL fallback + temp-dir removal). Idempotent.
//

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(SCRIPT_DIR, 'boot-workspace-sandbox.mjs');

// The launcher needs to know where the app is. In a materialized workspace it
// has the location baked in (pass nothing). From the repo, ../../.. is the app
// — recognize it by its server.js and forward it.
const hasServerJs = dir => { try { return fs.existsSync(path.join(dir, 'server.js')); } catch { return false; } };
const repoRoot = path.resolve(SCRIPT_DIR, '../../..');

// Boot a sandbox of `fixture` — an absolute .liquidos path, or a file: URL
// (e.g. `new URL('./peer.liquidos', import.meta.url)` to point at a sibling).
// Resolves { url, workspace, teardown }.
// `agent` is one or more agent script paths (app-relative or absolute); each is
// forwarded as its own --agent. Defaults to the no-op agent. A URL/file: entry
// is converted to a path so a probe can name a sibling script.
export const bootSandbox = (fixture, { agent = 'agent/none-agent.js', app } = {}) => new Promise((resolve, reject) => {
  const source = fixture instanceof URL || String(fixture).startsWith('file:')
    ? fileURLToPath(fixture)
    : fixture;
  const appRoot = app || (hasServerJs(repoRoot) ? repoRoot : null);
  const toPath = a => (a instanceof URL || String(a).startsWith('file:')) ? fileURLToPath(a) : a;
  const agentScripts = (Array.isArray(agent) ? agent : [agent]).map(toPath);
  const args = ['--workspace', source, ...agentScripts.flatMap(a => ['--agent', a])];
  if (appRoot) args.push('--app', appRoot);

  const child = spawn('node', [LAUNCHER, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  const teardown = () => { try { child.kill('SIGTERM'); } catch {} };

  let buf = '';
  const onExit = () => reject(new Error('launcher exited before printing url'));
  child.on('exit', onExit);
  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    child.off('exit', onExit);
    try {
      const { url, workspace } = JSON.parse(buf.slice(0, nl));
      resolve({ url, workspace, teardown });
    } catch { teardown(); reject(new Error('non-json launcher output: ' + buf.slice(0, 200))); }
  });
});
