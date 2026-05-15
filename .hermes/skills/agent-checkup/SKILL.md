---
name: agent-checkup
description: Dry technical checklist for checking whether an agent completed canvas work correctly, including input.json shape, component file placement, callback wiring, and output queue state.
---

# Agent Checkup

Use this skill when reviewing agent work on a canvas.

## Checks

1. Inspect `input.json`.
   - `components[]` must be an array of string paths.
   - Each path should point to an existing component file inside the current canvas.

2. Inspect the referenced component files.
   - Confirm the file exists.
   - Confirm the file parses as JSON.
   - Confirm the component shape matches the renderer’s expected format.

3. Inspect view/truth layout.
   - Put rendered markup in the view file.
   - Put durable state in the truth file when needed.
   - Do not put rendered component objects inside `input.json`.

4. Inspect callback wiring.
   - Callback text must include the target component context.
   - The callback should point at the component path it is updating.
   - Use the same path in the prompt text and the rendered control when applicable.

5. Inspect `output.json`.
   - Remove stale failed jobs after cleanup.
   - Keep only the records that still matter for the current canvas state.

6. Inspect the live result.
   - Verify the canvas renders without `/input` errors.
   - Verify the expected component is visible.
   - If the result is wrong, fix the file shape before anything else.
