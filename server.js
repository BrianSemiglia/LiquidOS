const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const ROOT_COMPONENT = path.join(ROOT, 'component.json');
const clients = new Set();
let watchers = [];

const send = (res, status, body, headers = {}) => {
    res.writeHead(status, {
        'Cache-Control': 'no-cache',
        ...headers
    });
    res.end(body);
};

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const absoluteFrom = (baseFile, value) =>
    path.isAbsolute(value) ? value : path.resolve(path.dirname(baseFile), value);

const rootComponentEntries = () => {
    const root = json(ROOT_COMPONENT);
    return Array.isArray(root.components)
        ? root.components.map(entry => absoluteFrom(ROOT_COMPONENT, typeof entry === 'string' ? entry : entry.src)).filter(Boolean)
        : [ROOT_COMPONENT];
};

const leafComponents = () => {
    const root = json(ROOT_COMPONENT);

    if (!Array.isArray(root.components)) {
        return [{ source: ROOT_COMPONENT, component: root }];
    }

    return rootComponentEntries().map(source => ({
        source,
        component: json(source)
    }));
};

const publicComponents = () => ({
    components: leafComponents().map(({ component }, index) => ({
        ...component,
        file: component.file ? `/asset/${index}` : undefined
    }))
});

const dependencyFiles = () => [
    ROOT_COMPONENT,
    ...leafComponents().flatMap(({ source, component }) => [
        source,
        component.file ? absoluteFrom(source, component.file) : undefined
    ].filter(Boolean))
];

const broadcast = message => {
    for (const res of clients) {
        res.write(`data: ${message}\n\n`);
    }
};

const closeWatchers = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
};

const rebuildWatchGraph = () => {
    closeWatchers();

    for (const file of [...new Set(dependencyFiles())]) {
        try {
            watchers.push(fs.watch(file, { persistent: false }, () => {
                try {
                    rebuildWatchGraph();
                } catch (error) {
                    console.error('watch rebuild error:', error.message);
                }

                broadcast('reload');
            }));
        } catch (error) {
            console.error('watch error:', file, error.message);
        }
    }
};

const componentAsset = index => {
    const entry = leafComponents()[index];

    if (!entry?.component.file) return undefined;

    return absoluteFrom(entry.source, entry.component.file);
};

const serveAudio = (req, res, file) => {
    const stat = fs.statSync(file);
    const range = req.headers.range;

    if (!range) {
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache'
        });
        fs.createReadStream(file).pipe(res);
        return;
    }

    const [startText, endText] = range.replace('bytes=', '').split('-');
    const start = Number.parseInt(startText, 10);
    const end = endText ? Number.parseInt(endText, 10) : stat.size - 1;

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
    }

    res.writeHead(206, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file, { start, end }).pipe(res);
};

const serveStatic = (res, pathname) => {
    const requested = pathname === '/' ? '/index.html' : pathname;
    const file = path.resolve(ROOT, `.${decodeURIComponent(requested)}`);

    if (!file.startsWith(`${ROOT}${path.sep}`)) {
        send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
        return;
    }

    fs.readFile(file, (error, body) => {
        if (error) {
            send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
            return;
        }

        send(res, 200, body, {
            'Content-Type': path.extname(file) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream'
        });
    });
};

const server = http.createServer((req, res) => {
    const { pathname } = url.parse(req.url);

    try {
        if (pathname === '/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });
            res.write('data: connected\n\n');
            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
        }

        if (pathname === '/component') {
            send(res, 200, JSON.stringify(publicComponents()), { 'Content-Type': 'application/json; charset=utf-8' });
            return;
        }

        if (pathname.startsWith('/asset/')) {
            const file = componentAsset(Number(pathname.split('/').at(-1)));

            if (!file) {
                send(res, 404, 'No asset for component', { 'Content-Type': 'text/plain' });
                return;
            }

            serveAudio(req, res, file);
            return;
        }

        if (pathname === '/mp3') {
            const file = componentAsset(0);

            if (!file) {
                send(res, 404, 'No file in first component', { 'Content-Type': 'text/plain' });
                return;
            }

            serveAudio(req, res, file);
            return;
        }

        serveStatic(res, pathname);
    } catch (error) {
        console.error('request error:', error);
        send(res, 500, error.message, { 'Content-Type': 'text/plain' });
    }
});

try {
    rebuildWatchGraph();
} catch (error) {
    console.error('initial watch error:', error.message);
}

server.listen(PORT, () => console.log(`Server at http://localhost:${PORT}`));
