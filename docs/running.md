# Running LiquidOS

- A workspace (`.liquidos`) holds canvases, components, and relationships.
- A canvas is a screen that arranges and presents its components.
- A component is a self-contained piece of UI — markup plus optional behavior or
  a backend service.
- The harness (Go server + browser shell) renders the workspace and dispatches
  the agent when the user prompts.

## Running a workspace

```sh
./go-server/liquidos-server --workspace /path/to/Workspace.liquidos \
  --agent ./agent/hermes.js --port 3000
```

Required arguments:

```text
--workspace <*.liquidos folder>
--agent <agent-script-path>   repeatable; each is a module exporting a factory
                              (a bare function, a `default`, or a single
                              `*Agent` export) that returns an object with at
                              least `label` and `run`. The roster is the agents
                              you pass; the first is default-active; the label
                              is the identity — shown in the picker, persisted,
                              and used to switch — so labels must be unique.
--port <number>
```

Optional arguments:

```text
--agent-timeout-ms <number>
```

If omitted, the selected agent waits indefinitely instead of timing out.

`agent/` ships `hermes.js`, `claude.js`, `codex.js`, `pi.js`, and `none-agent.js`
(boots the harness with no working runtime, so a dispatched prompt rejects
loudly).

The server does not create or guess a workspace. The Mac app opens or creates
`.liquidos` folders, then launches the server with explicit arguments.

## Workspace layout

The `.liquidos` folder itself is the canvas root:

```text
Workspace.liquidos/
  ui-state.json          active canvas, active agent
  home/
    index.json           the components on this canvas, in order
    canvas.js            how this canvas presents them
    components/
      <name>/
        component.html
        feature-requirements.txt
  <other-canvas>/
    ...
```

The prompt bar can switch canvases, create a canvas, and send canvas-scoped
prompts. The whole workspace folder is one Git repo — every agent turn is a
commit — so activity across canvases has a single timeline.

## Components with a backend

A component that needs a long-running process declares it inline, and the
service updates the view by writing files the component renders — it has no
output channel of its own. `skills/component/SKILL.md` is the contract.

## Building

```sh
node scripts/build-client.mjs          # collect the client assets the server embeds
cd go-server && go build -o liquidos-server .
```

`mac-app/build-liquidos-app.sh` builds the Mac app; `npm run dist` in
`electron-app/` builds the Linux AppImage and .deb.

## Tests

The probe suite drives the app the way a user does and asserts only what a
person can see. Run one, or the whole suite at 8-way concurrency:

```sh
node skills/testing/scripts/run-probe.mjs skills/testing/scripts/probe-canvas-build
ls -d skills/testing/scripts/probe-* | xargs -P8 -n1 node skills/testing/scripts/run-probe.mjs
```
