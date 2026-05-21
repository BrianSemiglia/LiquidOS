#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const fail = message => {
  console.error(message);
  process.exit(1);
};

const parseArguments = argv => argv.reduce((result, value, index) => {
  if (value === '--workspace') return { ...result, workspace: argv[index + 1] };
  if (value === '--app') return { ...result, app: argv[index + 1] };
  return result;
}, {});

const { workspace, app } = parseArguments(process.argv.slice(2));

if (!workspace || !app) {
  fail('usage: node scripts/boot-workspace-sandbox.mjs --workspace /path/to/Workspace.liquidos --app /path/to/app');
}

const sourceWorkspace = path.resolve(workspace);
const appDirectory = path.resolve(app);

if (!fs.existsSync(sourceWorkspace) || !fs.statSync(sourceWorkspace).isDirectory()) {
  fail(`workspace not found or not a directory: ${sourceWorkspace}`);
}

if (path.extname(sourceWorkspace) !== '.liquidos') {
  fail(`workspace must be the .liquidos folder, not a canvas/home folder: ${sourceWorkspace}`);
}

if (!fs.existsSync(path.join(sourceWorkspace, 'home', 'input.json'))) {
  fail(`workspace is missing home/input.json: ${sourceWorkspace}`);
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

const useServerJs = fs.existsSync(path.join(appDirectory, 'server.js'));
const useNpmStart = Boolean(readPackageJson(appDirectory).scripts?.start);

if (!useServerJs && !useNpmStart) {
  fail(`app directory has no server.js or package.json start script: ${appDirectory}`);
}

const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liquidos-sandbox-'));
const sandboxWorkspace = path.join(sandboxRoot, path.basename(sourceWorkspace));
const logsPath = path.join(sandboxRoot, 'logs');
const stdoutLog = fs.createWriteStream(path.join(logsPath, 'app.stdout.log'));
const stderrLog = fs.createWriteStream(path.join(logsPath, 'app.stderr.log'));

fs.mkdirSync(logsPath, { recursive: true });
fs.cpSync(sourceWorkspace, sandboxWorkspace, { recursive: true });

const appProcess = spawn(
  useServerJs ? 'node' : 'npm',
  useServerJs
    ? ['server.js', '--workspace', sandboxWorkspace, '--agent', 'none', '--port', '0']
    : ['start', '--', '--workspace', sandboxWorkspace, '--agent', 'none', '--port', '0'],
  {
    cwd: appDirectory,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  }
);

const extractUrl = text =>
  text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? text.match(/http:\/\/localhost:\d+/)?.[0];

const waitForUrl = child =>
  new Promise((resolve, reject) => {
    let settled = false;

    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };

    const timeout = setTimeout(
      () => {
        if (!settled) {
          settled = true;
          reject(new Error(`app did not print a local URL; sandbox: ${sandboxWorkspace}; logs: ${logsPath}`));
        }
      },
      15000
    );

    const read = data => {
      const text = String(data);
      const url = extractUrl(text);

      if (url) {
        finish(url.replace('localhost', '127.0.0.1'));
      }
    };

    child.stdout.on('data', data => {
      stdoutLog.write(data);
      read(data);
    });

    child.stderr.on('data', data => {
      stderrLog.write(data);
      read(data);
    });

    child.on('error', error => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });

    child.on('exit', code => {
      stdoutLog.end();
      stderrLog.end();

      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`app exited before URL was available: ${code}; sandbox: ${sandboxWorkspace}; logs: ${logsPath}`));
      }
    });
  });

const shutdown = () => {
  if (!appProcess.killed) {
    appProcess.kill('SIGTERM');
  }

  setTimeout(() => {
    if (!appProcess.killed) {
      appProcess.kill('SIGKILL');
    }
  }, 1000).unref();
};

process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(143);
});

try {
  process.stdout.write(`${JSON.stringify({
    url: await waitForUrl(appProcess),
    workspace: sandboxWorkspace
  })}\n`);
} catch (error) {
  shutdown();
  fail(error.message);
}

await new Promise(resolve => appProcess.on('exit', resolve));
