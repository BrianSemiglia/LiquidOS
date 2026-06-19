#!/usr/bin/env node
// The other canvas's ticker service — same shape as home's, with an
// OTHER_INSTANCE marker so the probe can tell the two canvases' output apart.
const fs = require('node:fs');
const path = require('node:path');

const compHtmlPath = path.join(path.dirname(__filename), 'component.html');
const instance = process.pid + '-' + Math.floor(Math.random() * 1e9);

let n = 0;
const tick = () => {
    n += 1;
    fs.writeFileSync(
        compHtmlPath,
        '<liquidos-component path="components/ticker">\n' +
        '    <liquidos-file path="components/ticker/service.js" run></liquidos-file>\n' +
        '    <p data-ticker>OTHER_INSTANCE ' + instance + ' STEP ' + n + '</p>\n' +
        '</liquidos-component>\n'
    );
};

tick();
setInterval(tick, 250);
