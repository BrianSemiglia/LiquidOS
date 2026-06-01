---
name: testing
description: Test a LiquidOS workspace or component through the actual app UI
triggers:
  - User asks to test a workspace
  - User asks to verify a component in the app
  - User asks to inspect the actual UI
---

# Testing Workspaces

Use this skill when changing a workspace or component and you need to verify the result through the actual app UI.

## Contract

The launcher receives a source workspace and the app path. It creates a sandboxed copy, boots that copy with testing disabled, then prints one JSON object.

```sh
node ./testing/scripts/boot-workspace-sandbox.mjs \
  --workspace /path/to/Workspace.liquidos \
  --app /path/to/app
```

Output:

```json
{"url":"http://127.0.0.1:49123","workspace":"/tmp/liquidos-sandbox-abc123/Workspace.liquidos"}
```

## Runtime context

The app path is available in:

```txt
./runtime.json
```

Use the `app` value from that file as the `--app` argument.

## Workspace argument

Pass the `.liquidos` folder itself:

```txt
/path/to/Clock.liquidos
```

The launcher validates that the workspace contains:

```txt
home/input.json
```

## Component testing workflow

```txt
1. Start the sandbox launcher as a process.
2. Read the JSON object from stdout.
3. Open output.url with Playwright.
4. Inspect and edit output.workspace while testing.
5. Use the browser like a user would.
6. Reboot the sandbox when a clean run is useful.
7. Apply the verified change to the source workspace via /workspace/apply.
8. Terminate the launcher process when finished.
```

## Applying changes back to the source workspace

When the changes verify in the sandbox, hand the list of changed files to the **source** server's apply endpoint:

```sh
curl -X POST http://127.0.0.1:<source-port>/workspace/apply \
    -H 'content-type: application/json' \
    -d '{
      "sandbox": "<sandbox-workspace-path>",
      "files": ["<workspace-relative path>", ...]
    }'
```

What the endpoint does, in one shot:

- Validates each file path is workspace-relative, exists in the sandbox, and resolves inside both the sandbox and the source (no traversal).
- Pauses the source server's filesystem watcher.
- Copies each file from `sandbox/<rel>` → `source/<rel>`, creating parent directories as needed.
- Resumes the watcher and emits one refresh.

The user sees a single coherent update instead of a per-file flicker. If any copy fails partway, the response is 500 with a count of how many landed; the workspace is left in a partial state and the next refresh is emitted so the client sees what actually happened.

Workspace-relative paths look like `"home/components/foo/presented/view.html"`. Absolute paths and `..` traversal are rejected.

## Useful checks

```txt
Canvas loads.
The component appears.
Expected controls are visible.
User interactions change the UI as expected.
State follows the intended refresh/persistence behavior.
Browser console is free of relevant runtime errors.
```

## Playwright shape

```js
const sandbox = spawn('node', [
  './testing/scripts/boot-workspace-sandbox.mjs',
  '--workspace', sourceWorkspace,
  '--app', JSON.parse(fs.readFileSync('./runtime.json', 'utf8')).app
]);

const { url, workspace } = JSON.parse(await firstStdoutLine(sandbox));

await page.goto(url);
```

## Shutdown

Terminate the launcher process when verification is complete.

## Services during testing

The sandbox boots the copied workspace the same way the app does. Components that include `services/start.sh` are started and stopped by the harness. Components without `services/start.sh` render from `view.json` only.

Use the returned `url` for browser testing and the returned `workspace` for sandbox edits.
