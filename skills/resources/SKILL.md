---
name: resources
description: Explain how LiquidOS components declare and load resources
triggers:
  - User asks about component assets or resources
  - User asks how to reference files in a component
  - User asks about resource URLs in LiquidOS
---

# Component Resources

Do not reference canvas-local files directly with `components/...` URLs in HTML.

Declare files in `view.json` under `resources`, then use `{{ resources.name.url }}` in markup.

`resources.*.path` should be canvas-relative or component-local. External folders should be served separately over HTTP instead of using absolute paths or `file://` URLs.
