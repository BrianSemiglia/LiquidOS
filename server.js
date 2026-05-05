const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

const argValue = (name, fallback) => {
    const prefix = name + '=';
    const inline = process.argv.find(arg => arg.startsWith(prefix));

    if (inline) {
        return inline.slice(prefix.length);
    }

    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1] || fallback;
};

const resolveConfigPath = value =>
    path.isAbsolute(value) ? value : path.resolve(ROOT, value);

const INPUT_PATH = resolveConfigPath(argValue('--input', 'input.json'));
const OUTPUT_PATH = resolveConfigPath(argValue('--output', 'output.json'));
const DELTAS_PATH = resolveConfigPath(
    argValue('--deltas', path.join(path.dirname(INPUT_PATH), 'deltas.json'))
);
const PORT = Number.parseInt(argValue('--port', '3000'), 10);

const clients = new Set();
let watchers = [];
let watchTimer;
let processingDeltas = false;

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

const pointerParts = pointer => {
    if (pointer === '') {
        return [];
    }

    if (!pointer.startsWith('/')) {
        throw new Error('JSON Patch path must start with /: ' + pointer);
    }

    return pointer.slice(1).split('/').map(part =>
        part.replace(/~1/g, '/').replace(/~0/g, '~')
    );
};

const isObject = value =>
    value !== null && typeof value === 'object';

const hasKey = (value, key) =>
    Object.prototype.hasOwnProperty.call(value, key);

const arrayIndex = (key, length, allowEnd = false) => {
    if (!/^(0|[1-9]\d*)$/.test(key)) {
        throw new Error('Invalid array index: ' + key);
    }

    const index = Number(key);
    const max = allowEnd ? length : length - 1;

    if (index < 0 || index > max) {
        throw new Error('Array index out of bounds: ' + key);
    }

    return index;
};

const pointerPath = parts =>
    parts.length ? '/' + parts.map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : '';

const pointerParent = (document, pointer) => {
    const parts = pointerParts(pointer);

    if (!parts.length) {
        return { key: undefined, parent: undefined };
    }

    let parent = document;

    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];

        if (Array.isArray(parent)) {
            parent = parent[arrayIndex(part, parent.length)];
            continue;
        }

        if (!isObject(parent) || !hasKey(parent, part)) {
            throw new Error('Path does not exist: ' + pointerPath(parts.slice(0, index + 1)));
        }

        parent = parent[part];
    }

    if (!isObject(parent)) {
        throw new Error('Path parent is not an object or array: ' + pointer);
    }

    return {
        parent,
        key: parts[parts.length - 1]
    };
};

const cloneJson = value =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const lookupPointer = (document, pointer) => {
    let current = document;

    for (const part of pointerParts(pointer)) {
        if (Array.isArray(current)) {
            current = current[arrayIndex(part, current.length)];
            continue;
        }

        if (!isObject(current) || !hasKey(current, part)) {
            return { exists: false, value: undefined };
        }

        current = current[part];
    }

    return { exists: true, value: cloneJson(current) };
};

const addPointer = (document, pointer, value) => {
    if (pointer === '') {
        return cloneJson(value);
    }

    const { parent, key } = pointerParent(document, pointer);

    if (Array.isArray(parent)) {
        parent.splice(key === '-' ? parent.length : arrayIndex(key, parent.length, true), 0, cloneJson(value));
    } else {
        parent[key] = cloneJson(value);
    }

    return document;
};

const removePointer = (document, pointer) => {
    if (pointer === '') {
        return undefined;
    }

    const { parent, key } = pointerParent(document, pointer);

    if (Array.isArray(parent)) {
        parent.splice(arrayIndex(key, parent.length), 1);
    } else {
        if (!hasKey(parent, key)) {
            throw new Error('Path does not exist: ' + pointer);
        }

        delete parent[key];
    }

    return document;
};

const replacePointer = (document, pointer, value) => {
    if (pointer === '') {
        return cloneJson(value);
    }

    const { parent, key } = pointerParent(document, pointer);

    if (Array.isArray(parent)) {
        parent[arrayIndex(key, parent.length)] = cloneJson(value);
    } else {
        if (!hasKey(parent, key)) {
            throw new Error('Path does not exist: ' + pointer);
        }

        parent[key] = cloneJson(value);
    }

    return document;
};

const applyJsonPatch = (document, ops) =>
    ops.reduce((next, op) => {
        if (op.op === 'add') {
            return addPointer(next, op.path, op.value);
        }

        if (op.op === 'remove') {
            return removePointer(next, op.path);
        }

        if (op.op === 'replace') {
            return replacePointer(next, op.path, op.value);
        }

        throw new Error('Unsupported JSON Patch op: ' + op.op);
    }, cloneJson(document));

const inverseOps = ops =>
    [...ops].reverse().map(op => {
        if (op.op === 'add') {
            return op.beforeExists
                ? { op: 'replace', path: op.appliedPath || op.path, value: op.before }
                : { op: 'remove', path: op.appliedPath || op.path };
        }

        if (op.op === 'remove') {
            return { op: 'add', path: op.path, value: op.before };
        }

        if (op.op === 'replace') {
            return { op: 'replace', path: op.path, value: op.before };
        }

        throw new Error('Unsupported JSON Patch op: ' + op.op);
    });

const applyPatchSet = patchSet => {
    patchSet.forEach(patch => {
        const file = resolveFromRoot(patch.file);
        const current = readJson(file);
        writeJson(file, applyJsonPatch(current, patch.ops || []));
    });
};

const ensurePatchBefores = patchSet =>
    patchSet.map(patch => {
        const file = resolveFromRoot(patch.file);
        let current = readJson(file);

        const ops = (patch.ops || []).map(op => {
            const nextOp = { ...op };
            let lookup;

            if (op.op === 'add' && op.path !== '') {
                const { parent } = pointerParent(current, op.path);

                lookup = Array.isArray(parent)
                    ? { exists: false, value: undefined }
                    : lookupPointer(current, op.path);
            } else {
                lookup = lookupPointer(current, op.path);
            }

            if (!Object.hasOwn(nextOp, 'beforeExists')) {
                nextOp.beforeExists = lookup.exists;
            }

            if (lookup.exists && !Object.hasOwn(nextOp, 'before')) {
                nextOp.before = lookup.value;
            }

            if (op.op === 'add' && !Object.hasOwn(nextOp, 'appliedPath')) {
                if (op.path === '') {
                    nextOp.appliedPath = '';
                } else {
                    const parts = pointerParts(op.path);
                    const { parent, key } = pointerParent(current, op.path);

                    nextOp.appliedPath = Array.isArray(parent) && key === '-'
                        ? pointerPath([...parts.slice(0, -1), String(parent.length)])
                        : op.path;
                }
            }

            current = applyJsonPatch(current, [op]);
            return nextOp;
        });

        return { ...patch, ops };
    });

const processDeltas = () => {
    if (processingDeltas || !fs.existsSync(DELTAS_PATH)) {
        return false;
    }

    processingDeltas = true;

    try {
        const deltas = readJson(DELTAS_PATH);
        let changed = false;

        if (!Array.isArray(deltas)) {
            throw new Error('deltas.json must be an array');
        }

        deltas.forEach(delta => {
            if (delta.format !== 'json-patch') {
                return;
            }

            try {
                if (delta.status === 'pending') {
                    delta.patches = ensurePatchBefores(delta.patches || []);
                    applyPatchSet(delta.patches);
                    delta.status = 'applied';
                    delta.appliedAt = new Date().toISOString();
                    changed = true;
                    return;
                }

                if (delta.status === 'rollback-pending') {
                    const rollbackPatches = (delta.patches || []).map(patch => ({
                        ...patch,
                        ops: inverseOps(patch.ops || [])
                    }));
                    applyPatchSet(rollbackPatches);
                    delta.status = 'rolled-back';
                    delta.rolledBackAt = new Date().toISOString();
                    changed = true;
                    return;
                }

                if (delta.status === 'reapply-pending') {
                    applyPatchSet(delta.patches || []);
                    delta.status = 'applied';
                    delta.reappliedAt = new Date().toISOString();
                    changed = true;
                }
            } catch (error) {
                delta.status = 'failed';
                delta.error = error.message;
                delta.failedAt = new Date().toISOString();
                changed = true;
            }
        });

        if (changed) {
            writeJson(DELTAS_PATH, deltas);
        }

        return changed;
    } finally {
        processingDeltas = false;
    }
};

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

const resourceUrl = (index, name) =>
    '/input/' + index + '/resources/' + encodeURIComponent(name);

const componentResources = component => {
    const resources = Object.fromEntries(
        Object.entries(component.resources || {}).map(([name, resource]) => [
            name,
            typeof resource === 'string' ? { path: resource } : resource
        ])
    );

    if (component.file && !resources.file) {
        resources.file = {
            path: component.file,
            mime: component.type
        };
    }

    return resources;
};

const renderedResources = (index, resources) =>
    Object.fromEntries(
        Object.entries(resources).map(([name, resource]) => [
            name,
            {
                ...resource,
                url: resourceUrl(index, name)
            }
        ])
    );

const renderedHtml = (index, component, resources) =>
    String(component.html || '')
        .replaceAll('data-input-file', 'src="/input/' + index + '/file"')
        .replace(/\{\{\s*resources\.([A-Za-z0-9_-]+)\.url\s*\}\}/g, (match, name) =>
            resources[name] ? resourceUrl(index, name) : match
        );

const renderedInput = () => ({
    ...readJson(INPUT_PATH),
    components: leafComponents().map(({ index, componentPath, component }) => {
        const resources = componentResources(component);

        return {
            ...component,
            index,
            componentPath,
            resources: renderedResources(index, resources),
            file: component.file ? '/input/' + index + '/file' : undefined,
            html: renderedHtml(index, component, resources)
        };
    })
});

const watchedFiles = () =>
    Array.from(new Set([
        INPUT_PATH,
        DELTAS_PATH,
        ...leafComponents().flatMap(({ componentPath, component }) =>
            [
                componentPath,
                component.file,
                ...Object.values(componentResources(component)).map(resource => resource.path)
            ].filter(Boolean)
        )
    ]));

const broadcast = () => {
    clients.forEach(res => res.write('data: update\n\n'));
};

const scheduleWatchRefresh = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
        try {
            const deltasChanged = processDeltas();
            watchGraph();
            if (deltasChanged) {
                scheduleWatchRefresh();
            }
        } catch (error) {
            console.error('watch error:', error.message);
            scheduleWatchRefresh();
            return;
        }

        broadcast();
    }, 50);
};

const watchGraph = () => {
    watchers.forEach(watcher => watcher.close());
    watchers = [];

    watchedFiles().forEach(file => {
        watchers.push(fs.watch(file, { persistent: false }, scheduleWatchRefresh));
    });
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
            resources: componentResources(leaf.component),
            data: leaf.component.data || null,
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

        const inputResource = url.pathname.match(/^\/input\/(\d+)\/resources\/(.+)$/);

        if (req.method === 'GET' && inputResource) {
            const component = leafComponents()[Number(inputResource[1])]?.component;
            const name = decodeURIComponent(inputResource[2]);
            const resource = component && componentResources(component)[name];

            if (!resource?.path) {
                send(res, 404, 'Input resource not found');
                return;
            }

            streamFile(req, res, resource.path, resource.mime || resource.type);
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

if (!fs.existsSync(DELTAS_PATH)) {
    writeJson(DELTAS_PATH, []);
}

processDeltas();
watchGraph();
server.listen(PORT, () => {
    console.log('Server at http://localhost:' + PORT);
    console.log('Input: ' + INPUT_PATH);
    console.log('Output: ' + OUTPUT_PATH);
    console.log('Deltas: ' + DELTAS_PATH);
});
