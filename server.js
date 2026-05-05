const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const INPUT_PATH = path.join(ROOT, 'input.json');
const OUTPUT_PATH = path.join(ROOT, 'output.json');

const clients = new Set();
let watchers = [];

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const writeJson = (file, value) => {
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, file);
};

const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, {
        'Cache-Control': 'no-cache',
        'Content-Type': type
    });
    res.end(body);
};

const resolveFromRoot = value =>
    path.isAbsolute(value) ? value : path.resolve(ROOT, value);

const inputEntries = () => {
    const input = readJson(INPUT_PATH);

    if (!Array.isArray(input.components)) {
        throw new Error('input.json must contain { "components": [...] }');
    }

    return input.components.map((componentPath, index) => {
        if (typeof componentPath !== 'string') {
            throw new Error('input.json components[' + index + '] must be a string path');
        }

        return {
            index,
            componentPath: resolveFromRoot(componentPath)
        };
    });
};

const leafComponents = () =>
    inputEntries().map(entry => ({
        ...entry,
        component: readJson(entry.componentPath)
    }));

const renderedInput = () => ({
    components: leafComponents().map(({ index, componentPath, component }) => ({
        ...component,
        index,
        componentPath,
        file: component.file ? '/input/' + index + '/file' : undefined,
        html: String(component.html || '')
            .replaceAll('data-input-file', 'src="/input/' + index + '/file"')
    }))
});

const watchedFiles = () => [
    INPUT_PATH,
    ...leafComponents().flatMap(({ componentPath, component }) =>
        [componentPath, component.file].filter(Boolean)
    )
];

const broadcast = () => {
    clients.forEach(res => res.write('data: update\n\n'));
};

const watchGraph = () => {
    watchers.forEach(watcher => watcher.close());
    watchers = [];

    try {
        watchedFiles().forEach(file => {
            watchers.push(fs.watch(file, { persistent: false }, () => {
                watchGraph();
                broadcast();
            }));
        });
    } catch (error) {
        console.error('watch error:', error.message);
    }
};

const readBody = req =>
    new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });

const appendOutput = async req => {
    const body = JSON.parse(await readBody(req));
    const index = Number(body.componentIndex);
    const prompt = String(body.prompt || '').trim();
    const leaf = leafComponents()[index];

    if (!leaf || !prompt) {
        throw new Error('Prompt requires a valid componentIndex and prompt');
    }

    const output = fs.existsSync(OUTPUT_PATH) ? readJson(OUTPUT_PATH) : [];

    if (!Array.isArray(output)) {
        throw new Error('output.json must be an array');
    }

    writeJson(OUTPUT_PATH, [
        ...output,
        {
            createdAt: new Date().toISOString(),
            componentPath: leaf.componentPath,
            file: leaf.component.file || null,
            prompt
        }
    ]);
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

const staticPath = pathname => {
    const file = path.resolve(ROOT, pathname === '/' ? 'index.html' : '.' + decodeURIComponent(pathname));
    return file.startsWith(ROOT + path.sep) || file === ROOT ? file : undefined;
};

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');

        if (req.method === 'GET' && url.pathname === '/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });
            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/input') {
            send(res, 200, JSON.stringify(renderedInput()), 'application/json; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/output') {
            await appendOutput(req);
            send(res, 204, '');
            return;
        }

        const inputFile = url.pathname.match(/^\/input\/(\d+)\/file$/);

        if (req.method === 'GET' && inputFile) {
            const component = leafComponents()[Number(inputFile[1])]?.component;

            if (!component?.file) {
                send(res, 404, 'Input file not found');
                return;
            }

            streamFile(req, res, component.file, component.type);
            return;
        }

        const file = staticPath(url.pathname);

        if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            send(res, 404, 'Not found');
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
        send(res, 500, 'Error: ' + error.message);
    }
});

if (!fs.existsSync(OUTPUT_PATH)) {
    writeJson(OUTPUT_PATH, []);
}

watchGraph();
server.listen(3000, () => console.log('Server at http://localhost:3000'));
