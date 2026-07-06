#!/usr/bin/env node
// Long-running service for the service-driven view-update probe. Writes
// successive component.html values on a short interval so the probe can
// observe progressive updates on the rendered DOM.
const fs = require('node:fs');
const path = require('node:path');

const compHtmlPath = path.join(path.dirname(__filename), 'component.html');

let n = 0;
const tick = () => {
    n += 1;
    fs.writeFileSync(
        compHtmlPath,
        '<liquidos-component path="components/target">\n    <liquidos-file path="components/target/service.js" run></liquidos-file>\n    <p data-marker>SERVICE_STEP_' + n + '</p>\n</liquidos-component>\n'
    );
};

tick();
setInterval(tick, 250);
