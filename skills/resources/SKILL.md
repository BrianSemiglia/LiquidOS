---
name: resources
description: How LiquidOS components declare and load resources
---

# Component Resources

Do not reference canvas-local files directly with `components/...` URLs in HTML.

Declare files in `view.json` under `resources`, then use `{{ resources.name.url }}` in markup.

`resources.*.path` should be canvas-relative or component-local. External folders should be served separately over HTTP instead of using absolute paths or `file://` URLs.
