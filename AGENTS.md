# AGENTS.md

For coding agents editing this repo (the LiquidOS harness). The runtime agent's prompt is a separate file, `skills/AGENTS.md`; `skills/` is shipped to the runtime agent, so editing it changes runtime behavior, not repo behavior.

## LiquidOS

- A generative-UI host: an LLM agent builds and live-edits a user's interface.
- A workspace (`.liquidos`) holds canvases, components, and relationships — user data, not repo code.
- A canvas is a screen that arranges and presents its components.
- A component is a self-contained piece of UI — markup plus optional behavior or a backend service.
- A relationship wires one component's output into another's input.
- The harness (Node server + browser shell) renders the workspace and dispatches the agent when the user prompts.
- The user watches the UI change live as the agent works.

## Practices

- UI test driven — hit an issue, write the failing UI test first, then pass it.
- Prove it through the UI — a test drives the app the way a user does (type, click, reload) and asserts **only what a person can see**: a unique rendered string via `innerText`, and — when persistence matters — that it's still there after a reload. Never read internals: private globals (`__io`), diagnostics, the wire protocol, disk layout, the persisted file, HTML structure, CSS classes, element/`hidden` flags. Reaching past the rendered UI ("prying") is a **rare last resort** that needs a comment justifying why no on-screen proof exists — never the normal shape of a test.
- UI-proven tests are zero-knowledge proofs — they prove the behavior is present without encoding *how* it's built. That is the whole point: the rendering, the protocol, the data shape, and where state persists can all be refactored and the test still passes, untouched. A test changes **only** when the requirement it encodes changes — never to chase a refactor.
- Tests are the source of truth — private details change, tests don't; when a test and the code disagree, the test wins.
- Tests must discriminate — assert the real behavior, not a happy path a wrong implementation would also pass (e.g. change state by another path, then prove the code read it).
- No legacy — one way to do a thing; migrate old workspaces forward, prove code is dead before removing it.
- State is events, not polling — no timeouts, deadlines, or retries to wait for readiness.
- Skill docs say what and when, not how.
- Workspaces own their git — never commit a workspace.
- Own mistakes honestly — "verified" is not "should work."

## Running the UI tests

- Probes live in `skills/testing/scripts/probe-*.mjs`; run one (or several) with `node skills/testing/scripts/run-probe.mjs <probe>...`. The runner boots and tears down its own sandbox and browser per probe.
- `run-probe.mjs` runs the probes it's given sequentially. To run the whole suite, launch the runner per probe and cap concurrency yourself — **8 at a time** is a good default (each probe owns a sandbox + browser, so don't run them all unbounded):

  ```sh
  ls skills/testing/scripts/probe-*.mjs | xargs -P8 -n1 node skills/testing/scripts/run-probe.mjs
  ```
