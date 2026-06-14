# Microphone Activity Component

A backend-process component. The entry is `component.html`:

```html
<liquidos-component path="components/browser-native">
    <liquidos-file path="components/browser-native/services/start.sh" run></liquidos-file>
    <liquidos-file path="components/browser-native/rendered.html"></liquidos-file>
</liquidos-component>
```

Layout:

```text
browser-native/
  component.html
  feature-requirements.txt
  rendered.html             (painted output the canvas displays)
  services/
    start.sh
    render.js
    IO.swift
    package.json
  data/
    truth.json              (fast-changing state from the Swift process)
    .runtime/
      IO
      service.log
```

`services/start.sh` starts the Swift microphone monitor and a renderer HTTP service. The Swift process writes fast-changing microphone state to `data/truth.json`. The renderer streams updates to the already-rendered view via Server-Sent Events, so the harness doesn't need to re-render the canvas for every volume update. The renderer writes `rendered.html` once when the service starts so the view has the current local stream URL.

The Mac app bundle must include `NSMicrophoneUsageDescription` so macOS can show the microphone permission prompt.
