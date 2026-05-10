---
name: live-edit-runtime
description: Runtime abstraction for localized Canvas execution. Each CanvasRuntime owns paths, Hermes host, watchers, and job queue, enabling safe canvas switching.
---

# Live‑Edit Runtime Skill

## Overview
In the original Live‑Edit server, numerous global variables (e.g., CANVAS_PATH,
INPUT_PATH, OUTPUT_PATH, activeCanvasHermes) were repointed each time a
canvas was switched.  This made it hard to reason about the life-cycle, caused
state leakage between canvases, and made unit-testing difficult.

The live-edit-runtime skill introduces a single source of truth per canvas:
the CanvasRuntime object.  It owns all file paths, the Hermes host, file
watchers, and job queue state.

## Key Types

class CanvasRuntime {
  canvasPath: string;
  inputPath: string;
  outputPath: string;
  deltasPath: string;
  componentsPath: string;
  activeOutputKeys: Set<string>;
  hermes: HermesHost | null;
  watchers: Array<fs.FSWatcher>;
  processingDeltas: boolean;

  start(): CanvasRuntime;   // initialise & start runtime
  stop(): CanvasRuntime;    // clean up
}

## Life-Cycle
1. Creation - createCanvasRuntime(canvasPath) resolves absolute paths.
2. Start - runtime.start()
   - Ensures input.json, output.json, deltas.json exist.
   - Recovers abandoned running jobs by marking them failed.
   - Launches a Hermes host for the canvas.
   - Processes any pending deltas.
   - Registers file watchers for the canvas.
   - Triggers the output job dispatcher.
3. Switch - switchCanvas(name)
   - Calls activeRuntime.stop() (if any).
   - Creates a new CanvasRuntime and starts it.
   - Re-initialises watchers and Hermes for the new canvas.
4. Stop - runtime.stop()
   - Stops watchers.
   - Kills Hermes host cleanly.
   - Clears activeOutputKeys and in-memory state.

## Recap of Functions that Become Runtime-Scoped
- readOutputJobs(runtime), updateOutputJob(runtime, ...)
- watchGraph(runtime), processDeltas(runtime)
- startCanvasHermesHost(runtime), stopCanvasHermesHost(runtime), sendToHermes(runtime, prompt)
- dispatchOutputJobs(runtime), feedHermesOutput(runtime)

## Useful Reference
See the references/ folder for:
- state-expectations.md: Expected state after a start, before a switch, and after stop.
- abandoned-job-recovery.md: How running jobs are recovered on start.
- watcher-scope.md: File-watcher list per canvas.

## Integration Notes
When migrating an existing file that relied on global paths, replace every
INPUT_PATH/OUTPUT_PATH/DELTAS_PATH reference with runtime.inputPath etc.
Also pass runtime into any helper that previously used the globals.

## Testing
Use the unit tests in tests/runtime.test.js (provided in the repo) to
assert that:
- The start method creates missing JSON files.
- An abandoned running job becomes failed.
- Switching canvases stops the old Hermes host.