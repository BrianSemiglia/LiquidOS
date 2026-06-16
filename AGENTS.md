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
- Tests assert on rendered output — drive the UI, check on-screen text/state a user can see; never read private internals (`__io`, diagnostics, disk, structure). Present a unique string to the screen to prove the thing you're proving.
- Tests are the source of truth — private details change, tests don't; when a test and the code disagree, the test wins.
- Tests must discriminate — assert the real behavior, not a happy path a wrong implementation would also pass (e.g. change state by another path, then prove the code read it).
- No legacy — one way to do a thing; migrate old workspaces forward, prove code is dead before removing it.
- State is events, not polling — no timeouts, deadlines, or retries to wait for readiness.
- Skill docs say what and when, not how.
- Workspaces own their git — never commit a workspace.
- Own mistakes honestly — "verified" is not "should work."
