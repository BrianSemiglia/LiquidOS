#!/usr/bin/env node
// A running service for the agent-updates-view probe. The probe asserts only on
// the marker the AGENT writes to component.html, never on this service's output,
// so it just needs to stay alive. It uses no view channel (no fd 3, no lqpatch).
const keepAlive = setInterval(() => {}, 1000);
process.on('SIGTERM', () => { clearInterval(keepAlive); process.exit(0); });
process.on('SIGINT', () => { clearInterval(keepAlive); process.exit(0); });
