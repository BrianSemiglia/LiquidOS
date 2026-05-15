# Live Canvas Component State Design

Use this skill when creating or updating Live Canvas components.

This is the app-owned copy. On launch, LiquidOS copies it into the live canvas tree so the agent can read the runtime version at `.hermes/skills/component-instance-creator-updater/SKILL.md`.

## Core Contract

This rule applies to every component-driven job, not just search jobs.

- A canvas job is not complete until it has written a visible component to disk and referenced it from `input.json`.
- The component is the user-facing progress surface. Do not let logs, debug text, or internal inspection stand in for a visible component update.
- When I say to show or update a component, I mean produce the component, write it to disk, and reference it from `input.json` so the canvas can render it.
- `input.json.components` is always an array of string paths. Do not write inline component objects into `input.json`.
- Create the component file first, then insert its path into the canvas manifest.
- When the user is adding a component, create a new sibling component instead of overwriting an existing one.
- Treat the component as a live UI surface inside a graphical operating system, not a chatbot transcript, a dashboard, or a background crawl.
- The first visible action for every prompt-bar request is to write a loading shell component to disk and add its path to `input.json`.
- No filesystem search, asset scan, log read, or solution synthesis is allowed until that loading shell exists on disk and is visible on the canvas.
- If you feel tempted to start by finding files, gathering results, or inspecting the machine, stop and materialize the loading shell first.
- The loading shell must appear before any meaningful work begins.
- Update the same component progressively as results arrive so the user can see the agent’s state change in real time.
- The visible component should show activity, not just a static loading shell.
- Make the component feel like a polished Apple-quality interface: beautiful, minimal, calm, and intentionally spaced.
- Prefer previews, thumbnails, contact sheets, embedded media, or the closest direct visual representation the surface supports.
- If a file is an image, video, or audio asset, show the asset itself or a preview of it. File-name lists are a fallback, not the default output.
- Do not choose text over media just because text is easier. If you can render the actual asset or a real preview, do that.
- Keep existing successful components visible when the user is starting a new, unrelated request.
- Once the requested component is complete enough to satisfy the user, stop.

## Structured Thinking

For each prompt, reduce the task to this JSON-shaped plan before doing any work:

```json
{
  "action": "create_loading_component",
  "state": "<html of the component>",
  "write_to_disk": true
}
```

- `action` names the next move.
- `state` is the HTML for the component that should be written now.
- `write_to_disk` is `true` whenever the canvas should update.
- Use this structure to guide the component update path. Do not split it into a separate planning artifact.

## Workflow

This is the expected loop for any prompt-bar request that needs a component:

1. Prompt arrives.
2. Agent creates a loading component and writes it to disk.
3. Agent begins work.
4. Agent partially completes work and rewrites the component to reflect the new state.
5. Agent continues work.
6. Agent partially completes work and rewrites the component to reflect the new state.
7. Agent completes work and rewrites the component to reflect the final state.
8. Agent marks the job as done.

The component is the progress surface. It should show the agent’s state before, during, and after the work. Do not split the flow into a separate planning artifact.
