#!/usr/bin/env node
//
// run-probe.mjs — the testing wrapper around the sandbox launcher.
//
// For each probe: boot a sandbox of the probe's fixture (via
// boot-workspace-sandbox.mjs), open a browser, import the probe and call it
// with { url, workspace, page, browser }, then tear it all down — the
// launcher, the browser, the temp dir — no matter what. A leak is impossible
// because teardown lives in a `finally`, not in the probe.
//
// boot-workspace-sandbox.mjs stays a plain "boot a sandbox, print the url"
// primitive; every test-only concern (browser, probes, fixtures, teardown)
// lives here, in the wrapper.
//
// A probe is a module:
//   export const fixture = './probe-name.liquidos';   // the probe's own copy, sitting next to it
//   export const agent = 'none';              // optional server runtime; default 'none'
//   export default async ({ url, workspace, page, browser }) => { ... };
// Throw to fail, return to pass. --workspace / --agent override the exports.
//
// Usage:
//   node run-probe.mjs <probe.mjs> [more-probes...] [--workspace ...] [--agent ...] [--app ...]
//

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootSandbox } from './sandbox.mjs';

const PROBE_TIMEOUT_MS = 180000;

const parseArgs = argv => {
  const out = { probes: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--workspace') out.workspace = argv[++i];
    else if (v === '--agent') out.agent = argv[++i];
    else if (v === '--app') out.app = argv[++i];
    else if (v === '--run') out.probes.push(argv[++i]);
    else if (!v.startsWith('--')) out.probes.push(v);
  }
  return out;
};

const { probes, workspace, agent, app } = parseArgs(process.argv.slice(2));
if (!probes.length) {
  console.error('usage: node run-probe.mjs <probe.mjs> [...] [--workspace ...] [--agent ...] [--app ...]');
  process.exit(1);
}

const withTimeout = (promise, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS).unref())
]);

const { chromium } = await import('playwright');
let exitCode = 0;

for (const probe of probes) {
  const probeAbs = path.resolve(probe);
  const name = path.basename(probeAbs);
  if (!fs.existsSync(probeAbs)) { console.error(`[run-probe] probe not found: ${probeAbs}`); exitCode = 1; continue; }

  let mod;
  try { mod = await import(pathToFileURL(probeAbs).href); }
  catch (e) { console.error(`[run-probe] ${name} failed to load: ${e.message}`); exitCode = 1; continue; }
  const run = mod.default || mod.run;
  if (typeof run !== 'function') {
    console.error(`[run-probe] ${name}: must export a default async function({ url, workspace, page, browser })`);
    exitCode = 1;
    continue;
  }

  // Which workspace: --workspace override, else the probe's exported fixture.
  // A probe that exports `fixture = null` manages its own sandbox(es) — e.g. it
  // scaffolds a workspace at runtime, or needs two peers. We skip the pre-boot
  // for those and just hand it the browser (it uses `bootSandbox` from
  // sandbox.mjs itself and tears its own down).
  // The probe's `fixture` is a path relative to the probe file itself — its own
  // .liquidos copy sits right next to it. `--workspace` overrides.
  const selfManaged = mod.fixture === null && !workspace;
  const source = workspace ? path.resolve(workspace)
    : (mod.fixture ? path.resolve(path.dirname(probeAbs), mod.fixture) : null);
  if (!selfManaged && !source) { console.error(`[run-probe] ${name}: no --workspace given and the probe exports no \`fixture\``); exitCode = 1; continue; }
  // The probe's `agent` is one or more agent script path(s); defaults to the
  // no-op agent. --agent overrides.
  const agentScripts = agent || mod.agent || 'agent/none-agent.js';

  let sandbox = { url: null, workspace: null, teardown: () => {} };
  if (!selfManaged) {
    try { sandbox = await bootSandbox(source, { agent: agentScripts, app }); }
    catch (e) { console.error(`[run-probe] ${name} boot failed: ${e.message}`); exitCode = 1; continue; }
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await withTimeout(run({ url: sandbox.url, workspace: sandbox.workspace, page, browser }), name);
    console.error(`[run-probe] ${name} ✓`);
  } catch (e) {
    console.error(`[run-probe] ${name} ✗ ${e.message}`);
    exitCode = 1;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    sandbox.teardown();
    await new Promise(r => setTimeout(r, 1100)); // let the launcher's SIGTERM→SIGKILL + temp-dir cleanup run
  }
}

process.exit(exitCode);
