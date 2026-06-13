---
name: testing
description: Test a LiquidOS workspace or component through the actual app UI
triggers:
  - User reports something doesn't look, feel, or work right
---

# Testing Workspaces

Use this skill when changing a workspace or component and you need to verify the result through the actual app UI.

## A probe is a function

A probe is a module that exports a single async function. The test runner boots a sandbox, opens a browser, hands your function `{ url, workspace, page, browser }`, and **tears everything down afterward — no matter what.** You never boot, parse, or clean up anything.

```js
export const fixture = 'Clock.liquidos';   // a folder under skills/testing/fixtures
export const agent = 'none';               // optional server runtime; omit to default to 'none'

export default async ({ url, workspace, page, browser }) => {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // ... drive the app the way a user would ...
  if (!(await onScreen(page, 'WHAT THE USER ASKED FOR')))
    throw new Error('it never showed up on screen');
};
```

**Throw to fail, return to pass.** That's the whole contract.

- `url` — the running sandbox.
- `workspace` — the sandbox's `.liquidos` path on disk, if you need to seed or inspect a file.
- `page` — a fresh Playwright page. Need a second client? `const page2 = await browser.newPage()`. Need a viewport? `await page.setViewportSize({ width, height })`.
- `browser` — the Playwright browser, for extra pages.

## Run it

```sh
node skills/testing/scripts/run-probe.mjs path/to/probe.mjs [more-probes...]
```

The runner imports each probe, boots the sandbox for its `fixture` (or `--workspace <path>` to override), runs it, prints `✓`/`✗`, and exits non-zero if any probe failed. Repeat the path for several probes. There is no launcher to start and no process to remember to kill — the runner owns the sandbox **and** the browser, in a `finally`, so a probe that throws or hangs can't leak either. The app location is baked into the launcher by the server, so you don't pass `--app` (only when running from a raw source checkout: `--app /path/to/liquidos-source`).

## Assert what a person sees

A test should answer one question: *is the thing I'm looking for on the screen?* Assert a **unique visible string**, via rendered text — not HTML structure, not op names, not the wire protocol, not private globals, not disk layout. That way the rendering, the protocol, and where a patch persists can all change without touching the test.

```js
// innerText is the rendered, visible text — skips hidden nodes, <style>, <script>.
const onScreen = (page, text) => page.evaluate(t => document.body.innerText.includes(t), text);
```

Drive the app the way the user does (type into the prompt bar, click the button), then assert the result is visible — and, when it matters, still visible after a reload (proving it persisted).

## Fixtures, agents, and self-managed probes

- **`fixture`** names a folder under `skills/testing/fixtures`. The runner sandboxes a copy, so the probe can mutate it freely.
- **`agent`** is the server's agent runtime. Default `'none'` runs the harness but no agent (callbacks fail loudly; testing can't recurse). Probes that need a working dispatch loop name a per-scenario test agent (these live in `agent/test/`).
- **`fixture = null`** means *the probe manages its own sandbox(es)* — it scaffolds a workspace at runtime, or needs two peers. The runner then skips the pre-boot and just hands you `browser`. Boot your own with the shared helper:

```js
import { bootSandbox } from './sandbox.mjs';

export const fixture = null;
export default async ({ browser }) => {
  const sandbox = await bootSandbox('/abs/path/or/fixture-name.liquidos', { agent: 'none' });
  try {
    const page = await browser.newPage();
    await page.goto(sandbox.url);
    // ...
  } finally {
    sandbox.teardown();   // SIGTERM → SIGKILL fallback → temp-dir removal
  }
};
```

A two-peer probe is the same idea: declare one peer as the `fixture` (driven through the provided `page`) and `bootSandbox(...)` the other, tearing it down in a `finally`. See `probe-cross-peer-share.mjs`.

## Save the probe

Save the probe in a `tests/` folder next to what it verifies — `<canvas>/components/<name>/tests/` for a component, `<canvas>/tests/` for the canvas. Run it before declaring the change done. Update a probe in the same turn its assertions become intentionally wrong.

## Useful checks

```txt
Canvas loads.
The component appears.
Expected controls are visible.
User interactions change the UI as expected.
State follows the intended refresh/persistence behavior (survives a reload).
Browser console is free of relevant runtime errors.
```

## Applying changes back to the source workspace

When the changes verify in the sandbox, POST the batch to the **source** server's writes endpoint:

```sh
curl -X POST http://127.0.0.1:<source-port>/workspace/writes \
    -H 'content-type: application/json' \
    -d '{
      "sandbox": "<sandbox-workspace-path>",
      "writes": [
        { "path": "<workspace-relative>", "from": "<sandbox-relative>" },
        { "path": "<workspace-relative>", "content": <inline JSON value> }
      ]
    }'
```

Each `write` entry is one of:

- `{ path, content }` — inline JSON value, written to the workspace as pretty JSON.
- `{ path, from }` — copy from disk. `from` resolves against the optional top-level `sandbox` when relative, or can be absolute.

What the endpoint does, in one shot:

- Validates each path is workspace-relative; resolves inside the workspace; if a `from` is sandbox-relative, also inside the sandbox.
- Pauses the source server's filesystem watcher.
- Processes each write in order, creating parent directories as needed.
- Resumes the watcher and emits one refresh broadcast.

The user sees a single coherent update instead of a per-file flicker. If any write fails partway, the response is 500 with a count of how many landed; the workspace is left in a partial state and a refresh is emitted so the client sees what actually happened. Workspace-relative paths look like `"home/components/foo/component.html"`. Absolute paths and `..` traversal are rejected for `path`.

## Services during testing

The sandbox boots the copied workspace the same way the app does. Components whose `component.html` declares a `<liquidos-file run>` element have that file spawned (and torn down) by the harness. Components without a `run` element render from `component.html` only.
