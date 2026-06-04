# Microphone Activity Component

Uses the `view.json` + `services/` + `data/` contract.

```text
browser-native/
  view.json
  services/
    start.sh
    render.js
    IO.swift
    package.json
  data/
    truth.json
    .runtime/
      IO
      service.log
```

`services/start.sh` starts the Swift microphone monitor and a renderer HTTP service.

The Swift process writes fast-changing microphone state to `data/truth.json`.
The renderer streams updates to the already-rendered view with Server-Sent Events, so the harness does not need to re-render the canvas for every volume update.

The renderer writes `view.json` once when the service starts so the view has the current local stream URL.

The Mac app bundle must include `NSMicrophoneUsageDescription` so macOS can show the microphone permission prompt.
