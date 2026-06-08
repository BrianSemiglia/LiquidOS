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

    // data/, diagnostics/ live at the component folder root.
    const componentDataPath = componentPath =>
        path.join(componentFolderPath(componentPath), 'data');

    const componentDiagnosticsPath = componentPath =>
        path.join(componentFolderPath(componentPath), 'diagnostics');

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

    // componentNeedsRepair derives one boolean per component from
    // diagnostics/status.json — true iff any category recorded ok:false.
    // Rendering reads this so the Repair button is a pure function of
    // state. The file is the single source of truth (agent reads it per
    // skills/component/SKILL.md convention); this is just a one-line
    // summary at the harness/render boundary so the client doesn't have
    // to know the file schema.
    const componentNeedsRepair = componentPath => {
        try {
            const statusPath = path.join(componentDiagnosticsPath(componentPath), 'status.json');
            if (!fs.existsSync(statusPath)) return false;
            const data = JSON.parse(fs.readFileSync(statusPath, 'utf8')) || {};
            return Object.values(data).some(entry => entry && entry.ok === false);
        } catch (error) {
            return false;
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

    // Components own their own paint via <liquidos-file> tags inside
    // component.html. /input doesn't ship view content — the canvas's
    // canvas.js handles rendering and the chrome's load() short-circuits
    // when the canvas exposes no place() method. Snapshot only needs the
    // entry's identity; component fields stay empty.
    const loadLeafComponent = entry => ({
        ...entry,
        component: { html: '', title: '' }
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

    const canvasJsPath = () => path.join(getCanvasPath(), 'canvas.js');

    const canvasJsVersion = () => {
        const file = canvasJsPath();
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return '';
        return String(fs.statSync(file).mtimeMs);
    };

    // Relationships are component-shaped folders under <canvas>/relationships/.
    // The harness mounts them invisibly and wires them to the canvas's regular
    // components via the I/O contract (surface.__io). They are NOT in input.json
    // and don't render UI of their own — they're the connective tissue.
    const relationshipsDir = () => path.join(getCanvasPath(), 'relationships');

    const relationshipEntries = () => {
        const dir = relationshipsDir();
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map((entry, index) => ({
                index,
                componentPath: path.join(dir, entry.name)
            }));
    };

    // Relationships have no view.json — they don't render. The component
    // shape (html + resources.functions) is synthesized from convention:
    // every relationship folder has a functions.js at its root, full stop.
    // The harness mounts it onto a hidden surface and runs its connect().
    const relationshipComponents = () =>
        relationshipEntries().map(entry => ({
            ...entry,
            component: {
                html: '',
                resources: {
                    functions: {
                        path: path.relative(
                            getCanvasPath(),
                            path.join(entry.componentPath, 'functions.js')),
                        mime: 'text/javascript'
                    }
                }
            }
        }));

    const findRelationshipByPath = componentPath => {
        if (!componentPath) return null;
        const absolute = resolveCanvasReference(componentPath);
        const folder = componentFolderPath(absolute);
        return relationshipComponents().find(entry =>
            entry.componentPath === componentPath
            || entry.componentPath === absolute
            || componentScopePath(entry.componentPath) === componentPath
            || componentFolderPath(entry.componentPath) === componentPath
            || componentFolderPath(entry.componentPath) === absolute
            || componentFolderPath(entry.componentPath) === folder
        ) || null;
    };

    // Lookup against components first (the common case), then relationships,
    // so HTTP routes that serve view.json / resources / features can address
    // both with the same /component/<path>/... URL shape.
    const findAnyByPath = componentPath =>
        findLeafComponentByPath(componentPath) || findRelationshipByPath(componentPath);

    const renderedInput = () => {
        try {
            const input = readJson(getInputPath());

            if (!Array.isArray(input.components)) {
                throw new Error('input.json must contain { "components": [...] }');
            }

            const leaves = leafComponents();
            const renderEntry = ({ componentPath, component }) => ({
                componentPath,
                scope: componentScope(componentPath),
                repairLevel: component.repairLevel || '',
                html: renderedHtml(componentPath, component),
                resources: renderedResources(componentPath, component.resources || {}),
                needsRepair: componentNeedsRepair(componentPath)
            });
            return {
                canvasPath: getCanvasPath(),
                ...input,
                canvasJsVersion: canvasJsVersion(),
                components: leaves.map(renderEntry),
                relationships: relationshipComponents().map(renderEntry)
            };
        } catch (error) {
            return {
                canvasPath: getCanvasPath(),
                canvasJsVersion: '',
                canvasError: error.message,
                components: [{
                    componentPath: getCanvasPath(),
                    scope: getCanvasPath(),
                    repairLevel: 'canvas',
                    html: renderedHtml(getCanvasPath(), invalidCanvasCard(error))
                }],
                relationships: []
            };
        }
    };

    const isInsideCanvas = file => {
        const relative = path.relative(getCanvasPath(), file);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    };

    // Watch the entire component folder recursively. file-change events
    // bubble up to the SSE stream so <liquidos-file> elements can re-render
    // when the agent or a service writes to anything inside.
    const componentFolderEntries = (componentPaths, kind) =>
        componentPaths.flatMap(componentPath => {
            const folder = componentFolderPath(componentPath);
            if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory() || !isInsideCanvas(folder)) {
                return [];
            }
            return [{ path: folder, recursive: true, kind, componentPath }];
        });

    const watchedPaths = () => {
        const componentPaths = inputEntries().map(entry => entry.componentPath);
        const relationshipPaths = relationshipEntries().map(entry => entry.componentPath);
        const relationshipsDirPath = relationshipsDir();

        return [
            ...[getInputPath()].filter(Boolean).map(file => ({ path: file, recursive: false, kind: 'canvas' })),
            // Non-recursive watch on the canvas root to catch edits to
            // canvas.js. The watch callback in server.js filters by filename
            // so input.json (watched directly) and other top-level files
            // (active-canvas.json, state.json, etc.) don't trigger.
            ...[getCanvasPath()].filter(file => fs.existsSync(file) && fs.statSync(file).isDirectory())
                .map(file => ({ path: file, recursive: false, kind: 'canvas-root' })),
            ...componentFolderEntries(componentPaths, 'component'),
            // Non-recursive watch on relationships/ catches add/remove of
            // relationships themselves (a new bridge folder appearing).
            ...(fs.existsSync(relationshipsDirPath) && fs.statSync(relationshipsDirPath).isDirectory()
                ? [{ path: relationshipsDirPath, recursive: false, kind: 'relationships-root' }]
                : []),
            // Relationships use the same contract as components.
            ...componentFolderEntries(relationshipPaths, 'relationship')
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

    // Service supervision now lives in the <liquidos-file run> element —
    // canvas.js asks the harness to spawn scripts directly via /spawn.
    const componentServiceFolders = () => [];

    return {
        componentScopePath,
        componentScope,
        componentFileUrl,
        componentFolderPath,
        componentDataPath,
        componentDiagnosticsPath,
        canvasJsPath,
        canvasJsVersion,
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
        relationshipEntries,
        relationshipComponents,
        findLeafComponentByPath,
        findRelationshipByPath,
        findAnyByPath,
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
