# Component Creation/Updating

## Runtime canvas root

The current canvas root is provided in each task under `Target canvas.canvasPath`. Treat that absolute path as `<canvas>` for the whole task. Do not assume a static canvas path.

## Goal

A component should be a visual representation of the agent's activity and any data involved. It should be minimal, visually pleasing and useful. They should look like widgets designed by Apple.

## Workflow

1. Prompt arrives.
2. Agent creates or finds existing component and writes a loading version of it to disk inside `<canvas>/components/<component_name>/view.json`.
3. Agent adds component path to `<canvas>/input.json`
4. Agent begins work.
5. Agent partially completes work and overwrites the component to show the partial output and the agent's activity.
6. Agent continues work.
5. Agent partially completes work and overwrites the component to show the partial output and the agent's activity.
8. Agent completes work and overwrites the component to reflect the final state.
9. Agent responds as done.

## Example

`<canvas>/components/hello-world/view.json`:

```json
{
  "title": "Hello World",
  "html": "<h1>Hello, world.</h1>",
  "css": "h1{font-family:system-ui}"
}
```

`<canvas>/input.json`:

```json
{
  "components": [
    "components/hello-world/view.json"
  ]
}
```
