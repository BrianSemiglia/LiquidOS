#!/usr/bin/env node
// Placeholder service "A" — the one the probe starts with.
// The probe swaps component.html to point at service-b.js instead;
// the harness should kill this and spawn the other, without tearing
// down the component's rendered view.
setInterval(() => {}, 1 << 30);
