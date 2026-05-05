const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const COMPONENT_PATH = path.join(ROOT, 'component.json');
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

const resolveFromRoot = value =>
    path.isAbsolute(value) ? value : path.resolve(ROOT, value);

const componentPointers = () =>
    (json(COMPONENT_PATH).components || []).map(entry =>
        resolveFromRoot(typeof entry === 'string' ? entry : entry.src)
    );

const leafComponents = () =>
    componentPointers().map(file => ({
        path: file,
        component: json(file)
    }));

const publicComponents = () => ({
    components: leafComponents().map(({ component }, index) => ({
        ...component,
        html: String(component.html || '')
            .replaceAll('/asset/' + index, '/component/' + index + '/file')
            .replaceAll('data-component-file', 'src="/component/' + index + '/file"'),
        file: component.file ? '/component/' + index + '/file' : undefined
    }))
});

const watchedFiles = () => [
    COMPONENT_PATH,
    ...componentPointers(),
    ...leafComponents()
        .map(({ component }) => component.file)
        .filter(Boolean)
];

const broadcast = () => {
    clients.forEach(res => res.write('data: update\n\n'));
};

const closeWatchers = () => {
    watchers.forEach(watcher => watcher.close());
    watchers = [];
};

const watchGraph = () => {
    closeWatchers();

    try {
        watchedFiles().forEach(file => {
            watchers.push(fs.watch(file, { persistent: false }, () => {
                try {
                    watchGraph();
                } catch (error) {
                    console.error('watch rebuild error:', error);
                }

                broadcast();
            }));
        });
    } catch (error) {
        console.error('initial watch error:', error);
    }
};

const streamFile = (req, res, file, type = 'application/octet-stream') => {
    const stat = fs.statSync(file);
    const range = req.headers.range;

    if (!range) {
        res.writeHead(200, {
            'Content-Type': type,
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

    res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
    });

    fs.createReadStream(file, { start, end }).pipe(res);
};

const safeStaticPath = pathname => {
    const file = path.resolve(ROOT, pathname === '/' ? 'index.html' : '.' + decodeURIComponent(pathname));

    return file.startsWith(ROOT + path.sep) || file === ROOT ? file : undefined;
};

const server = http.createServer((req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');

        if (url.pathname === '/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
        }

        if (url.pathname === '/component') {
            send(res, 200, JSON.stringify(publicComponents()), {
                'Content-Type': 'application/json; charset=utf-8'
            });
            return;
        }

        const match = url.pathname.match(/^\/component\/(\d+)\/file$/);

        if (match) {
            const component = leafComponents()[Number(match[1])]?.component;

            if (!component?.file) {
                send(res, 404, 'Component file not found', { 'Content-Type': 'text/plain; charset=utf-8' });
                return;
            }

            streamFile(req, res, component.file, component.type);
            return;
        }

        const file = safeStaticPath(url.pathname);

        if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
            return;
        }

        streamFile(
            req,
            res,
            file,
            path.basename(file) === 'index.html' ? 'text/html; charset=utf-8' : undefined
        );
    } catch (error) {
        console.error('request error:', error);
        send(res, 500, 'Error: ' + error.message, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
});

watchGraph();

server.listen(3000, () => console.log('Server at http://localhost:3000'));
