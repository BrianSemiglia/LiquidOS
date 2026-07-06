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

Each test is its own folder — `probe-clock/` — holding everything it needs under short local names: the test is `index.mjs`, its fixture is `workspace.liquidos`, its agent (if any) is `agent.js`. The folder is the namespace, so nothing is shared between tests and nothing needs a qualified name.

```js
// skills/testing/scripts/probe-clock/index.mjs
export const fixture = './workspace.liquidos';   // this test's own fixture, in its folder
// agent: omit for the default no-op runtime; set './agent.js' (this test's own copy,
// in its folder) only when the probe needs a live dispatch loop

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
node skills/testing/scripts/run-probe.mjs path/to/probe-clock [more-probes...]
```

Point it at a test's folder (or its `index.mjs`). The runner imports the probe, boots the sandbox for its `fixture` (or `--workspace <path>` to override), runs it, prints `✓`/`✗`, and exits non-zero if any probe failed. Repeat the path for several probes. There is no launcher to start and no process to remember to kill — the runner owns the sandbox **and** the browser, in a `finally`, so a probe that throws or hangs can't leak either. The app location is baked into the launcher by the server, so you don't pass `--app` (only when running from a raw source checkout: `--app /path/to/liquidos-source`).

## Assert what a person sees

A test should answer one question: *is the thing I'm looking for on the screen?* Assert a **unique visible string**, via rendered text — not HTML structure, not op names, not the wire protocol, not private globals, not disk layout. That way the rendering, the protocol, and where a patch persists can all change without touching the test.

```js
// innerText is the rendered, visible text — skips hidden nodes, <style>, <script>.
const onScreen = (page, text) => page.evaluate(t => document.body.innerText.includes(t), text);
```

Drive the app the way the user does (type into the prompt bar, click the button), then assert the result is visible — and, when it matters, still visible after a reload (proving it persisted).

## Fixtures, agents, and self-managed probes

Everything a test needs lives in its folder under a local name, so no two tests ever share a fixture or an agent.

- **`fixture`** is `'./workspace.liquidos'` — the test's own `.liquidos` copy, in its folder. The runner sandboxes that copy, so the probe can mutate it freely. (A path is resolved relative to `index.mjs`, so any local name works.)
- **`agent`** is the server's agent runtime. Omit it for the default no-op runtime — the harness runs but no agent, so callbacks fail loudly and testing can't recurse. Probes that need a working dispatch loop set `'./agent.js'` — their own copy of the stub, in their folder. A test that flips between two agents uses `['./agent-a.js', './agent-b.js']`.
- **`fixture = null`** means *the probe manages its own sandbox(es)* — it scaffolds a workspace at runtime, or needs two peers. The runner then skips the pre-boot and just hands you `browser`. Boot your own with the shared helper (one directory up, since the test is a folder):

```js
import { bootSandbox } from '../sandbox.mjs';

export const fixture = null;
export default async ({ browser }) => {
  const sandbox = await bootSandbox(new URL('./workspace.liquidos', import.meta.url));
  try {
    const page = await browser.newPage();
    await page.goto(sandbox.url);
    // ...
  } finally {
    sandbox.teardown();   // stops the sandbox and cleans up its temp dir
  }
};
```

A two-peer probe is the same idea: declare one peer as the `fixture` (driven through the provided `page`) and `bootSandbox(new URL('./consumer.liquidos', import.meta.url), …)` the other from its own copy in the folder, tearing it down in a `finally`. A self-managed probe that needs its own agent passes it as a URL so it resolves in the folder: `bootSandbox(ws, { agent: new URL('./agent.js', import.meta.url) })`. See `probe-cross-peer-share/`.

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

When the changes verify in the sandbox, land each changed file into the source
workspace by writing it through the workspace endpoint: `PUT /workspace/<path>`,
one file per call, where `<path>` is workspace-relative (e.g.
`home/components/foo/component.html`). For a file you produced in the sandbox,
read its bytes and PUT them; there is no separate batch or copy endpoint.

The source server's watcher sees the writes and coalesces the burst into a
single refresh, so the user gets one coherent update — no per-file flicker.

## Services during testing

The sandbox boots the copied workspace the same way the app does. Components whose `component.html` declares a `<liquidos-file run>` element have that file spawned (and torn down) by the harness. Components without a `run` element render from `component.html` only.
