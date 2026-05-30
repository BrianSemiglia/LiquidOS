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
        '/component/' + encodeURIComponent(componentScopePath(componentPath)) + '/file';

    const componentResourceUrl = (componentPath, name) =>
        '/component/' + encodeURIComponent(componentScopePath(componentPath)) + '/resources/' + encodeURIComponent(name);

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


    const displayNameFromPath = value =>
        String(path.basename(path.dirname(value)) || path.basename(value) || 'Component')
            .replace(/\.[^.]+$/, '')
            .replace(/[-_]+/g, ' ')
            .replace(/\b\w/g, character => character.toUpperCase());

    const repairCard = ({ level, title, scope, error }) => ({
        title,
        scope,
        repairLevel: level,
        html:
            '<div role="group" aria-label="' + escapeHTML(title) + '" style="min-height:9rem;padding:1rem;border:1px solid rgba(248,113,113,0.45);border-radius:16px;background:rgba(127,29,29,0.22);color:#fecaca;display:grid;place-items:center;text-align:center;" data-repair-level="' + escapeHTML(level) + '">' +
            '<div style="display:grid;gap:0.75rem;justify-items:center;max-width:28rem;">' +
            '<div style="font-weight:750;font-size:1.05rem;letter-spacing:-0.01em;">' + escapeHTML(title) + '</div>' +
            '<liquidos-callback on="click" scope="' + escapeHTML(scope) + '" prompt="' + escapeHTML('Repair required due to error: ' + error.message) + '">' +
            '<button style="border:1px solid rgba(252,165,165,0.35);border-radius:999px;background:rgba(127,29,29,0.55);color:#fecaca;padding:0.55rem 0.9rem;font:inherit;font-weight:700;cursor:pointer;">Repair</button>' +
            '</liquidos-callback>' +
            '</div>' +
            '</div>',
        css: ''
    });

    const invalidComponentCard = (componentPath, error) => repairCard({
        level: 'component',
        title: displayNameFromPath(componentPath) + ' component is damaged',
        scope: componentScopePath(componentPath),
        error
    });

    const invalidCanvasCard = error => repairCard({
        level: 'canvas',
        title: 'Canvas is damaged',
        scope: getCanvasPath(),
        error
    });

    const componentFolderPath = componentPath =>
        fs.existsSync(componentPath) && fs.statSync(componentPath).isDirectory()
            ? componentPath
            : path.dirname(componentPath);

    // Per the component contract, the harness reads what the agent has
    // "presented" — everything inside the presented/ subdir of the component.
    // The agent stages multi-file changes in .presented/ alongside and swaps
    // atomically via `rm -rf presented && mv .presented presented`.
    const componentPresentedPath = componentPath =>
        path.join(componentFolderPath(componentPath), 'presented');

    const componentServicesPath = componentPath =>
        path.join(componentPresentedPath(componentPath), 'services');

    // data/ lives at the component root (outside presented/) so persistent
    // state survives presented/ swaps.
    const componentDataPath = componentPath =>
        path.join(componentFolderPath(componentPath), 'data');

    // diagnostics/ also lives at the component root so the agent has a stable
    // place to read failure info regardless of presented/ swaps.
    const componentDiagnosticsPath = componentPath =>
        path.join(componentFolderPath(componentPath), 'diagnostics');

    const componentViewPath = componentPath =>
        fs.existsSync(componentPath) && fs.statSync(componentPath).isDirectory()
            ? path.join(componentPresentedPath(componentPath), 'view.json')
            : componentPath;

    const componentStartPath = componentPath =>
        path.join(componentServicesPath(componentPath), 'start.sh');

    const componentViewCache = new Map();

    // updateDiagnostics writes <component>/diagnostics/status.json. The agent
    // reads this file as its first move when debugging. Each call merges into
    // an existing category; other categories are preserved.
    const updateDiagnostics = (componentPath, category, partial) => {
        try {
            const diagnosticsDir = componentDiagnosticsPath(componentPath);
            const statusPath = path.join(diagnosticsDir, 'status.json');

            fs.mkdirSync(diagnosticsDir, { recursive: true });

            let current = {};
            try {
                current = JSON.parse(fs.readFileSync(statusPath, 'utf8')) || {};
            } catch (error) {
                current = {};
            }

            const now = new Date().toISOString();
            const next = {
                ...current,
                updatedAt: now,
                [category]: { ...partial, at: now }
            };

            fs.writeFileSync(statusPath, JSON.stringify(next, null, 2) + '\n');
        } catch (error) {
            // Diagnostics write must never break component loading.
        }
    };

    const appendServiceLog = (componentPath, text) => {
        try {
            const diagnosticsDir = componentDiagnosticsPath(componentPath);
            fs.mkdirSync(diagnosticsDir, { recursive: true });
            fs.appendFileSync(path.join(diagnosticsDir, 'service.log'), text);
        } catch (error) {
            // Best-effort.
        }
    };

    const loadComponentView = componentPath => {
        const viewPath = componentViewPath(componentPath);
        let mtimeMs = null;

        try {
            mtimeMs = fs.statSync(viewPath).mtimeMs;
        } catch (error) {
            mtimeMs = null;
        }

        const cached = componentViewCache.get(viewPath);

        if (cached && mtimeMs !== null && cached.mtimeMs === mtimeMs) {
            return cached.component;
        }

        let component;

        try {
            validateComponentFile(componentPath);
            component = readJson(viewPath);
            updateDiagnostics(componentPath, 'view', { ok: true, error: null });
        } catch (error) {
            component = invalidComponentCard(viewPath, error);
            updateDiagnostics(componentPath, 'view', { ok: false, error: error.message });
        }

        if (mtimeMs !== null) {
            componentViewCache.set(viewPath, { mtimeMs, component });
        }

        return component;
    };

    const loadLeafComponent = entry => ({
        ...entry,
        component: loadComponentView(entry.componentPath)
    });

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
        const folder = componentFolderPath(absolute);

        return leafComponents().find(entry =>
            entry.componentPath === componentPath
            || entry.componentPath === absolute
            || componentScopePath(entry.componentPath) === componentPath
            || componentFolderPath(entry.componentPath) === componentPath
            || componentFolderPath(entry.componentPath) === absolute
            || componentScopePath(componentFolderPath(entry.componentPath)) === componentPath
            || componentScopePath(componentFolderPath(entry.componentPath)) === absolute
            || componentFolderPath(entry.componentPath) === folder
        ) || null;
    };

    const componentResources = (componentPath, component) =>
        component?.resources || {};

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

    const renderedInput = () => {
        try {
            const input = readJson(getInputPath());

            if (!Array.isArray(input.components)) {
                throw new Error('input.json must contain { "components": [...] }');
            }

            if (typeof input.presentation !== 'string' || !input.presentation.trim()) {
                throw new Error('input.json must contain { "presentation": "presentations/name.css" }');
            }

            return {
                canvasPath: getCanvasPath(),
                ...input,
                presentationVersion: inputReferenceVersion('presentation'),
                components: leafComponents().map(({ componentPath, component }) => ({
                    componentPath,
                    scope: componentScope(componentPath),
                    repairLevel: component.repairLevel || '',
                    html: renderedHtml(componentPath, component),
                    resources: renderedResources(componentPath, component.resources || {})
                }))
            };
        } catch (error) {
            return {
                canvasPath: getCanvasPath(),
                presentation: '',
                presentationVersion: '',
                canvasError: error.message,
                components: [{
                    componentPath: getCanvasPath(),
                    scope: getCanvasPath(),
                    repairLevel: 'canvas',
                    html: renderedHtml(getCanvasPath(), invalidCanvasCard(error))
                }]
            };
        }
    };

    const isInsideCanvas = file => {
        const relative = path.relative(getCanvasPath(), file);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    };

    const inputReferenceFile = name => {
        const input = readJson(getInputPath());
        return typeof input[name] === 'string' ? resolveCanvasReference(input[name]) : null;
    };

    const fileDirectoryWatchPath = file =>
        file
            ? fs.existsSync(file) && fs.statSync(file).isDirectory()
                ? file
                : path.dirname(file)
            : null;

    const inputReferenceWatchPath = name =>
        fileDirectoryWatchPath(inputReferenceFile(name));

    const inputReferenceVersion = name => {
        const file = inputReferenceFile(name);

        if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            return '';
        }

        return String(fs.statSync(file).mtimeMs);
    };

    // One recursive watch per component folder picks up every event inside,
    // including the presented/ directory swap. Events inside .presented/ (the
    // agent's staging area) are filtered out at the watch callback in server.js.
    const componentWatchPaths = componentPaths =>
        Array.from(new Set(componentPaths
            .map(componentFolderPath)
            .filter(file => fs.existsSync(file) && fs.statSync(file).isDirectory())
            .filter(isInsideCanvas)));

    const watchedPaths = () => {
        const componentPaths = inputEntries().map(entry => entry.componentPath);

        return [
            ...[getInputPath()].filter(Boolean).map(file => ({ path: file, recursive: false, kind: 'canvas' })),
            ...[inputReferenceWatchPath('presentation')]
                .filter(Boolean)
                .filter(file => fs.existsSync(file) && fs.statSync(file).isDirectory())
                .filter(isInsideCanvas)
                .map(file => ({ path: file, recursive: false, kind: 'presentation' })),
            ...componentWatchPaths(componentPaths).map(file => ({ path: file, recursive: true, kind: 'component' }))
        ];
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
            .map(entry => componentServicesPath(entry.componentPath))
            .filter(folder => fs.existsSync(path.join(folder, 'start.sh')));

    return {
        componentScopePath,
        componentScope,
        componentFileUrl,
        componentFolderPath,
        componentServicesPath,
        componentDataPath,
        componentDiagnosticsPath,
        componentViewPath,
        componentStartPath,
        updateDiagnostics,
        appendServiceLog,
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
        invalidComponentCard,
        invalidCanvasCard
    };
};

module.exports = {
    createCanvasGraph
};
