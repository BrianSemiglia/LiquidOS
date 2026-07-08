#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const fail = message => {
  console.error(message);
  process.exit(1);
};

// --agent is repeatable: each value is a path to an agent script. Forwarded
// verbatim to the server (resolved against the app dir below). Everything else
// is single-valued.
const parseArguments = argv => {
  const result = { agents: [] };
  argv.forEach((value, index) => {
    if (value === '--workspace') result.workspace = argv[index + 1];
    else if (value === '--app') result.app = argv[index + 1];
    else if (value === '--timeout-ms') result.timeoutMs = Number.parseInt(argv[index + 1], 10);
    else if (value === '--agent') result.agents.push(argv[index + 1]);
  });
  return result;
};

const { workspace, app, timeoutMs, agents } = parseArguments(process.argv.slice(2));
const bootTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
// Default to the no-op agent so the smoke-test workflow (callbacks fail loudly,
// the agent can't recurse) stays unchanged. Probes that need a working dispatch
// loop pass their own --agent script path(s).
const agentScripts = agents.length ? agents : ['agent/none-agent.js'];

// The server bakes the running app's location in here when it materializes
// this script into a workspace, so the runtime agent can boot a sandbox
// without hunting for where the app lives (no lsof, no NODE_PATH archaeology).
// The sentinel below means "not baked" — i.e. running straight from the repo —
// in which case pass --app explicitly.
const BAKED_APP_ROOT = '__LIQUIDOS_APP_ROOT__';
const resolvedApp = app || (BAKED_APP_ROOT.startsWith('__') ? undefined : BAKED_APP_ROOT);

if (!workspace || !resolvedApp) {
  fail('usage: node scripts/boot-workspace-sandbox.mjs --workspace /path/to/Workspace.liquidos [--app /path/to/app] [--agent <script-path> ...] [--timeout-ms 30000]\n(--app is optional inside a workspace — the server bakes the app location in)');
}

const sourceWorkspace = path.resolve(workspace);
const appDirectory = path.resolve(resolvedApp);

if (!fs.existsSync(sourceWorkspace) || !fs.statSync(sourceWorkspace).isDirectory()) {
  fail(`workspace not found or not a directory: ${sourceWorkspace}`);
}

if (path.extname(sourceWorkspace) !== '.liquidos') {
  fail(`workspace must be the .liquidos folder, not a canvas/home folder: ${sourceWorkspace}`);
}

if (!fs.existsSync(path.join(sourceWorkspace, 'home', 'index.json'))) {
  fail(`workspace is missing home/index.json: ${sourceWorkspace}`);
}

if (!fs.existsSync(appDirectory) || !fs.statSync(appDirectory).isDirectory()) {
  fail(`app directory not found: ${appDirectory}`);
}

const readPackageJson = directory => {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
};

const serverBinary = path.join(appDirectory, 'go-server', 'liquidos-server');
const useServerBinary = fs.existsSync(serverBinary);
const useNpmStart = Boolean(readPackageJson(appDirectory).scripts?.start);

if (!useServerBinary && !useNpmStart) {
  fail(`app directory has no go-server/liquidos-server or package.json start script: ${appDirectory}`);
}

// Pick a free port ourselves: bind ephemeral, read assigned port, release. The
// kernel won't immediately re-use it, so the spawned server reliably gets it.
const pickFreePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const port = await pickFreePort();
const url = `http://127.0.0.1:${port}`;

const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liquidos-sandbox-'));
const sandboxWorkspace = path.join(sandboxRoot, path.basename(sourceWorkspace));

fs.cpSync(sourceWorkspace, sandboxWorkspace, { recursive: true });

// Default --agent none: sandbox runs the harness but not an agent runtime,
// so callbacks fail loudly and the testing skill can't trigger itself
// recursively. Probes that need a working dispatch loop pass their own
// per-scenario --agent (the test agents live in agent/test/).
// Per-component diagnostics/service.log captures service output; we only
// inherit stderr so server-level boot errors land on the launcher's own
// stderr.
// Agent scripts ship with the app; resolve any relative path against the app
// dir so probes can name them app-relative (e.g. agent/test/foo-agent.js).
const agentArgs = agentScripts.flatMap(a => [
  '--agent', path.isAbsolute(a) ? a : path.join(appDirectory, a)
]);

const serverArgs = [
  '--workspace', sandboxWorkspace,
  ...agentArgs,
  '--port', String(port)
];

const appProcess = spawn(
  useServerBinary ? serverBinary : 'npm',
  useServerBinary ? serverArgs : ['start', '--', ...serverArgs],
  {
    cwd: appDirectory,
    env: process.env,
    stdio: ['ignore', 'ignore', 'inherit']
  }
);

const probeUrl = async () => {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
};

const waitForReady = child =>
  new Promise((resolve, reject) => {
    let settled = false;

    const finish = value => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      resolve(value);
    };

    const timeout = setTimeout(
      () => {
        if (!settled) {
          settled = true;
          clearInterval(poll);
          reject(new Error(`app did not become ready within ${bootTimeoutMs}ms; sandbox: ${sandboxWorkspace}`));
        }
      },
      bootTimeoutMs
    );

    const poll = setInterval(async () => {
      if (await probeUrl()) finish(url);
    }, 100);

    child.on('error', error => {
      if (!settled) {
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        reject(error);
      }
    });

    child.on('exit', code => {
      if (!settled) {
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        reject(new Error(`app exited before becoming ready: ${code}; sandbox: ${sandboxWorkspace}`));
      }
    });
  });

const cleanupSandbox = () => {
  try {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
};

const shutdown = () => {
  if (!appProcess.killed) {
    appProcess.kill('SIGTERM');
  }

  setTimeout(() => {
    if (!appProcess.killed) {
      appProcess.kill('SIGKILL');
    }
    cleanupSandbox();
  }, 1000).unref();
};

process.on('exit', cleanupSandbox);

// Don't process.exit() from the signal handlers — that runs synchronously and
// skips both the shutdown timer's SIGKILL fallback and the 'exit' cleanup. Let
// shutdown() kick off the child's termination and let the awaited
// appProcess.exit promise (below) drain naturally.
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  process.stdout.write(`${JSON.stringify({
    url: await waitForReady(appProcess),
    workspace: sandboxWorkspace
  })}\n`);
} catch (error) {
  shutdown();
  fail(error.message);
}

await new Promise(resolve => appProcess.on('exit', resolve));
