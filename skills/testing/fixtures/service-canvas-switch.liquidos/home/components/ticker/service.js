#!/usr/bin/env node
// Long-running service for the canvas-switch service-lifecycle probe. Each
// process picks a unique instance id at startup and writes it — alongside a
// step counter — into the component's view on a short interval. A restarted
// service shows a DIFFERENT instance id, which is how the probe observes that
// switching away tore this service down (and switching back respawned it).
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
        '    <p data-ticker>HOME_INSTANCE ' + instance + ' STEP ' + n + '</p>\n' +
        '</liquidos-component>\n'
    );
};

tick();
setInterval(tick, 250);
