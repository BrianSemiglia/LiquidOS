# Workspace Model

The `*.liquidos` folder is the workspace root and the canvas root.

```text
Workspace.liquidos/
  selected-canvas.json
  home/
    input.json
    output.json
    components/
    layouts/
    transitions/
  <canvas-name>/
    input.json
    output.json
    components/
    layouts/
    transitions/
```

Pass the `.liquidos` folder itself to the server, testing launcher, and canvas creation script. Do not create or target a separate `canvases/` folder.

A canvas path is always a direct child of the workspace root, such as `home` or `sketches`.
