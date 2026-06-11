#!/usr/bin/env node
// Long-running placeholder service for the service-restart probe.
// The stub agent rewrites this file (op=writeFile) to force the
// harness's run-mode liquidos-file to scheduleRestart() — that restart
// is the moment the disappear-on-reload bug we're chasing would show.
setInterval(() => {}, 1 << 30);
