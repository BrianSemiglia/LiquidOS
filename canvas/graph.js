const path = require('path');

const createCanvasGraph = ({
    fs,
    getCanvasPath,
    getInputPath,
    readJson,
    resolveCanvasReference
}) => {
    const componentScopePath = componentPath =>
        path.relative(getCanvasPath(), componentPath).split(path.sep).join('/');

    const componentFileUrl = componentPath =>
        '/component/' + encodeURIComponent(componentScopePath(componentViewPath(componentPath))) + '/file';

    const componentResourceUrl = (componentPath, name) =>
        '/component/' + encodeURIComponent(componentScopePath(componentViewPath(componentPath))) + '/resources/' + encodeURIComponent(name);

    const resourceUrl = (componentPath, name, resource) =>
        resource?.url ? String(resource.url) : componentResourceUrl(componentPath, name);

    const localResourcePath = resource =>
        resource?.path && !/^https?:\/\//i.test(String(resource.path)) ? String(resource.path) : null;

    const canvasLocalPath = file =>
        path.isAbsolute(file) ? path.normalize(file) : path.resolve(getCanvasPath(), file);

    const localResourceFile = resource =>
        localResourcePath(resource) ? canvasLocalPath(localResourcePath(resource)) : null;

    const componentScripts = html =>
        Array.from(String(html || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi), match => match[1]);

    const escapeHTML = value =>
        String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

    const invalidComponentCard = (componentPath, error) => ({
        title: 'This part needs a quick repair',
        componentPath,
        parseError: error.message,
        html:
            '<div style="padding:16px;border:1px solid #ef4444;border-radius:8px;background:#2a0f14;color:#fecaca;display:grid;gap:10px;">' +
            '<div style="font-weight:700;margin-bottom:8px;">This part needs a quick repair</div>' +
            '<div style="font-size:13px;line-height:1.45;color:#fecaca;">Something in this card could not be loaded correctly.</div>' +
            '<liquidos-callback on="click" scope="' +
            escapeHTML(componentScopePath(componentPath)) +
            '" prompt="' +
            escapeHTML(
                'The component at path ' +
                componentScopePath(componentPath) +
                ' has invalid JSON. Please repair.'
            ) +
            '"><button style="justify-self:start;border:1px solid rgba(252,165,165,0.35);border-radius:999px;background:rgba(127,29,29,0.55);color:#fecaca;padding:0.55rem 0.85rem;font:inherit;font-weight:700;cursor:pointer;">Repair it</button></liquidos-callback>' +
            '</div>',
        css: ''
    });

    const componentFolderPath = componentPath =>
        fs.existsSync(componentPath) && fs.statSync(componentPath).isDirectory()
            ? componentPath
            : path.dirname(componentPath);

    const componentObservedPath = componentPath => {
        const folder = componentFolderPath(componentPath);
        const observed = path.join(folder, 'observed');

        return fs.existsSync(observed) && fs.statSync(observed).isDirectory()
            ? observed
            : folder;
    };

    const componentDataPath = componentPath =>
        path.join(componentFolderPath(componentPath), 'data');

    const componentViewPath = componentPath =>
        fs.existsSync(componentPath) && fs.statSync(componentPath).isDirectory()
            ? path.join(componentObservedPath(componentPath), 'view.json')
            : componentPath;

    const componentStartPath = componentPath =>
        path.join(componentObservedPath(componentPath), 'start.sh');

    const loadLeafComponent = entry => {
        try {
            validateComponentFile(entry.componentPath);

            return {
                ...entry,
                component: readJson(componentViewPath(entry.componentPath))
            };
        } catch (error) {
            return {
                ...entry,
                component: invalidComponentCard(componentViewPath(entry.componentPath), error)
            };
        }
    };

    const inputEntries = () => {
        const input = readJson(getInputPath());

        if (!Array.isArray(input.components)) {
            throw new Error('input.json must contain { "components": [...] }');
        }

        return input.components.map((componentPath, index) => {
            if (typeof componentPath !== 'string') {
                throw new Error('input.json components[' + index + '] must be a string path');
            }

            return {
                index,
                componentPath: resolveCanvasReference(componentPath)
            };
        });
    };

    const leafComponents = () =>
        inputEntries().map(loadLeafComponent);

    const findLeafComponentByPath = componentPath => {
        if (!componentPath) {
            return null;
        }

        const absolute = resolveCanvasReference(componentPath);

        return leafComponents().find(entry =>
            entry.componentPath === componentPath
            || entry.componentPath === absolute
            || componentScopePath(entry.componentPath) === componentPath
        ) || null;
    };

    const componentResources = () => ({});

    const renderedResources = (componentPath, resources) =>
        Object.fromEntries(
            Object.entries(resources).map(([name, resource]) => [
                name,
                {
                    ...resource,
                    url: resourceUrl(componentPath, name, resource),
                    version: localResourceFile(resource) && fs.existsSync(localResourceFile(resource)) ? String(fs.statSync(localResourceFile(resource)).mtimeMs) : ''
                }
            ])
        );

    const renderedHtml = (componentPath, component) =>
        (component.css ? '<style>' + String(component.css) + '</style>' : '')
        + String(component.html || '');

    const componentScope = componentPath =>
        componentFolderPath(componentPath);

    const renderedInput = () => ({
        canvasPath: getCanvasPath(),
        ...readJson(getInputPath()),
        components: leafComponents().map(({ componentPath, component }) => ({
            scope: componentScope(componentPath),
            html: renderedHtml(componentPath, component)
        }))
    });

    const isInsideCanvas = file => {
        const relative = path.relative(getCanvasPath(), file);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    };

    const inputReferenceFile = name => {
        const input = readJson(getInputPath());
        return typeof input[name] === 'string' ? resolveCanvasReference(input[name]) : null;
    };

    const listFiles = folder => {
        if (!fs.existsSync(folder)) {
            return [];
        }

        return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
            const file = path.join(folder, entry.name);

            if (entry.isDirectory()) {
                return listFiles(file);
            }

            return entry.isFile() ? [file] : [];
        });
    };

    const componentObservedWatchPaths = componentPaths =>
        Array.from(new Set(componentPaths
            .flatMap(componentPath => listFiles(componentObservedPath(componentPath)))
            .filter(isInsideCanvas)));

    const watchedPaths = () => {
        const componentPaths = inputEntries().map(entry => entry.componentPath);

        return [
            ...[
                getInputPath(),
                inputReferenceFile('layoutPath'),
                inputReferenceFile('transitionPath')
            ].filter(Boolean),
            ...componentObservedWatchPaths(componentPaths)
        ].map(file => ({ path: file, recursive: false }));
    };

    const watchedFiles = () =>
        watchedPaths().map(entry => entry.path);

    const validateComponentFile = componentPath => {
        const component = readJson(componentViewPath(componentPath));
        const html = String(component.html || '');

        if (/<[^>]*<script\b/i.test(html)) {
            throw new Error('Component HTML contains a <script> tag inside another opening tag');
        }

        componentScripts(html).forEach(script => {
            new Function(script);
        });
    };

    const validateCanvasConfig = () => {
        const input = readJson(getInputPath());

        if (!Array.isArray(input.components)) {
            throw new Error('Canvas config must contain a components array');
        }

        input.components.forEach((componentPath, index) => {
            if (typeof componentPath !== 'string') {
                throw new Error('Canvas component path at index ' + index + ' must be a string');
            }
        });
    };

    const validateComponentFiles = componentPaths => {
        componentPaths.forEach(componentPath => {
            validateComponentFile(resolveCanvasReference(componentPath));
        });
    };

    const componentServiceFolders = () =>
        inputEntries()
            .map(entry => componentObservedPath(entry.componentPath))
            .filter(folder => fs.existsSync(path.join(folder, 'view.json')) && fs.existsSync(path.join(folder, 'start.sh')));

    return {
        componentScopePath,
        componentScope,
        componentFileUrl,
        componentFolderPath,
        componentObservedPath,
        componentDataPath,
        componentViewPath,
        componentStartPath,
        resourceUrl,
        componentResources,
        renderedResources,
        renderedHtml,
        renderedInput,
        watchedPaths,
        watchedFiles,
        inputEntries,
        componentServiceFolders,
        leafComponents,
        findLeafComponentByPath,
        validateCanvasConfig,
        validateComponentFiles,
        validateComponentFile,
        loadLeafComponent,
        invalidComponentCard
    };
};

module.exports = {
    createCanvasGraph
};
