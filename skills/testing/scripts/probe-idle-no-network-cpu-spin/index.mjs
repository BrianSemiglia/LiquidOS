//
// probe-idle-no-network-cpu-spin
//
// Regression guard for the libp2p CPU spin. A workspace that shares nothing
// must not start the P2P/DHT network at boot, and must therefore sit idle
// instead of pegging a CPU core.
//
// The bug: startNetwork() ran on every boot and joined the public IPFS DHT in
// server mode (kadDHT clientMode:false) — so the harness became a global DHT
// routing node, burning ~100% CPU for ~50s on a fresh boot (and indefinitely
// under load; one stuck process logged 133 minutes of CPU time) on a
// workspace that shares nothing. That starved the event loop and made the
// agent stop responding.
//
// This asserts the behaviour a user feels — the harness is quiet at rest:
//   1. GET /network/status reports running:false (the network never started).
//   2. The harness process accrues almost no CPU over an idle window.
//
// Sharing/discovery is covered elsewhere (probe-cross-peer-share,
// probe-canvas-unshare, probe-component-share-opt-out); this probe is only
// about not burning CPU when nothing is shared.
//

import { execSync } from 'node:child_process';

export const fixture = './workspace.liquidos';
export const agent = 'agent/none-agent.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Cumulative CPU seconds the process has used, parsed from `ps -o time=`
// (formats seen: "SS.ss", "MM:SS.ss", "HH:MM:SS").
const cpuSeconds = (pid) => {
  const raw = execSync(`ps -o time= -p ${pid}`, { encoding: 'utf8' }).trim();
  if (!raw) throw new Error(`no ps cputime for pid ${pid}`);
  return raw.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
};

// The harness process for this sandbox: its command line carries the unique
// temp workspace path, so a substring match is unambiguous.
const harnessPid = (workspace) => {
  const pids = execSync(`pgrep -f ${JSON.stringify('server.js --workspace ' + workspace)}`, { encoding: 'utf8' })
    .trim().split(/\s+/).filter(Boolean);
  if (!pids.length) throw new Error(`no harness process for workspace ${workspace}`);
  return Number(pids[0]);
};

export default async ({ url, workspace }) => {
  const pid = harnessPid(workspace);

  // Let boot warmup (JIT, the file watcher) settle so the window below
  // measures steady state rather than startup cost.
  await sleep(2000);

  // 1. Nothing is shared, so the network must never have started.
  const status = await fetch(url + '/network/status').then(r => r.json());
  if (status.running) {
    throw new Error('network is running for a workspace that shares nothing: ' + JSON.stringify(status));
  }
  console.log('network status: not running (correct for a no-share workspace)');

  // 2. The harness is quiet. The spin burned >100% of a core continuously; an
  //    idle harness uses a fraction of a second. A 1.5s ceiling over an 8s
  //    window sits well above idle and well below the spin, so it separates
  //    the two without flaking.
  const WINDOW_MS = 8000;
  const CEILING_S = 1.5;
  const before = cpuSeconds(pid);
  await sleep(WINDOW_MS);
  const used = cpuSeconds(pid) - before;
  console.log(`harness CPU over ${WINDOW_MS}ms idle: ${used.toFixed(2)}s (ceiling ${CEILING_S}s)`);
  if (used > CEILING_S) {
    throw new Error(`harness burned ${used.toFixed(2)}s CPU while idle (ceiling ${CEILING_S}s) — the network spin is back`);
  }
  console.log('idle harness stayed quiet');
};
