#!/usr/bin/env node
// Long-running service for the service-driven view-update probe. Writes
// successive view.json values on a short interval so the probe can
// observe progressive updates on the rendered DOM.
const fs = require('node:fs');
const path = require('node:path');

const viewPath = path.join(path.dirname(__filename), 'view.json');

let n = 0;
const tick = () => {
    n += 1;
    fs.writeFileSync(
        viewPath,
        JSON.stringify({ title: 'T', html: '<p data-marker>SERVICE_STEP_' + n + '</p>' })
    );
};

tick();
setInterval(tick, 250);
