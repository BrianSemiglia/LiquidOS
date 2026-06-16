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

    const escapeHTML = value =>
        String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');


    const repairCard = ({ level, title, scope, error, promptSuffix }) => ({
        title,
        scope,
        repairLevel: level,
        html:
            '<div role="group" aria-label="' + escapeHTML(title) + '" style="min-height:9rem;padding:1rem;border:1px solid rgba(248,113,113,0.45);border-radius:16px;background:rgba(127,29,29,0.22);color:#fecaca;display:grid;place-items:center;text-align:center;" data-repair-level="' + escapeHTML(level) + '">' +
            '<div style="display:grid;gap:0.75rem;justify-items:center;max-width:28rem;">' +
            '<div style="font-weight:750;font-size:1.05rem;letter-spacing:-0.01em;">' + escapeHTML(title) + '</div>' +
            '<liquidos-callback on="click" scope="' + escapeHTML(scope) + '" prompt="' + escapeHTML('Repair required due to error: ' + error.message + (promptSuffix || '')) + '">' +
            '<button style="border:1px solid rgba(252,165,165,0.35);border-radius:999px;background:rgba(127,29,29,0.55);color:#fecaca;padding:0.55rem 0.9rem;font:inherit;font-weight:700;cursor:pointer;">Repair</button>' +
            '</liquidos-callback>' +
            '</div>' +
            '</div>',
        css: ''
    });

    // Skill discovery is LLM-decided, so it's not reliable to assume the
    // agent will read canvas/SKILL.md on its own. Point it there from
    // the prompt — the skill is the canvas contract's single source.
    const CANVAS_REPAIR_CONTRACT = '\n\nThis is a canvas-shape problem — read skills/canvas/SKILL.md before acting.';
    const invalidCanvasCard = error => repairCard({
        level: 'canvas',
        title: 'Canvas is damaged',
        promptSuffix: CANVAS_REPAIR_CONTRACT,
        scope: getCanvasPath(),
        error
    });

    const componentFolderPath = componentPath =>
        fs.existsSync(componentPath) && fs.statSync(componentPath).isDirectory()
            ? componentPath
            : path.dirname(componentPath);

    const componentDiagnosticsPath = componentPath =>
        path.join(componentFolderPath(componentPath), 'diagnostics');

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

    // hasFailedDiagnostic checks any diagnostics/status.json (component or
    // relationship) for any category that recorded ok:false.
    const hasFailedDiagnostic = folder => {
        try {
            const statusPath = path.join(folder, 'diagnostics', 'status.json');
            if (!fs.existsSync(statusPath)) return false;
            const data = JSON.parse(fs.readFileSync(statusPath, 'utf8')) || {};
            return Object.values(data).some(entry => entry && entry.ok === false);
        } catch (error) {
            return false;
        }
    };

    // Relationship folders follow the "<sender>-to-<receiver>" naming
    // convention. The sender's name is the prefix before the first
    // "-to-". The receiver's name is the rest. (If "-to-" isn't present
    // we treat the relationship as unowned and skip it.)
    const relationshipSender = relName => {
        const idx = relName.indexOf('-to-');
        return idx > 0 ? relName.slice(0, idx) : null;
    };

    // componentNeedsRepair derives one boolean per component from its
    // own diagnostics PLUS any relationship where this component is the
    // sender. Relationships have no UI of their own, so their failures
    // surface on the sender — the component that, from the user's
    // perspective, owns "this thing should send to that thing." Rendering
    // reads this so the Repair button is a pure function of state.
    const componentNeedsRepair = componentPath => {
        const folder = componentFolderPath(componentPath);
        if (hasFailedDiagnostic(folder)) return true;
        // Sender check: walk the canvas's relationships, find any where
        // this component is the sender, return true if it has a failed
        // diagnostic.
        const componentName = path.basename(folder);
        const relsDir = relationshipsDir();
        if (!fs.existsSync(relsDir) || !fs.statSync(relsDir).isDirectory()) return false;
        try {
            const entries = fs.readdirSync(relsDir, { withFileTypes: true })
                .filter(entry => entry.isDirectory());
            for (const entry of entries) {
                if (relationshipSender(entry.name) !== componentName) continue;
                if (hasFailedDiagnostic(path.join(relsDir, entry.name))) return true;
            }
        } catch { /* fall through */ }
        return false;
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
                entryPath: componentPath,
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
            // A relationship IS a functions.js-bearing folder (see below).
            // Enforce that here: otherwise any stray folder under
            // relationships/ — e.g. a misplaced `diagnostics/` left by a
            // removed relationship — gets mounted as a phantom relationship
            // whose missing functions.js "fails to import," and the harness
            // then writes its own diagnostics back under relationships/,
            // compounding the mess. Real relationships always have it.
            .filter(entry => fs.existsSync(path.join(dir, entry.name, 'functions.js')))
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

            // Each entry must resolve to an existing file. Folder paths
            // and stale entries (component was renamed/deleted) both fall
            // through here and surface the canvas Repair card instead of
            // leaving the user staring at an empty canvas.
            const missing = inputEntries()
                .filter(({ componentPath }) =>
                    !fs.existsSync(componentPath) || !fs.statSync(componentPath).isFile());
            if (missing.length > 0) {
                const names = missing.map(m => input.components[m.index]).join(', ');
                throw new Error('input.json references components without a valid entry file: ' + names);
            }

            const leaves = leafComponents();
            const renderEntry = ({ componentPath, entryPath, component }) => ({
                componentPath,
                entryPath: entryPath || '',
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

    const watchedPaths = () => {
        const relationshipsDirPath = relationshipsDir();

        return [
            // input.json drives the graph — watch it directly so a component
            // add/remove re-reads the config.
            ...[getInputPath()].filter(Boolean).map(file => ({ path: file, recursive: false, kind: 'canvas' })),
            // One recursive watch on the whole canvas catches every file change
            // — canvas.js and any file inside any component — and never changes
            // as components come and go. So the watcher is never torn down and
            // recreated; that close/reopen cycle raced FSEvents and dropped
            // events, which was why patches wrote to disk but never painted.
            ...[getCanvasPath()].filter(file => fs.existsSync(file) && fs.statSync(file).isDirectory())
                .map(file => ({ path: file, recursive: true, kind: 'canvas-root' })),
            // relationships/ add/remove also changes the graph.
            ...(fs.existsSync(relationshipsDirPath) && fs.statSync(relationshipsDirPath).isDirectory()
                ? [{ path: relationshipsDirPath, recursive: false, kind: 'relationships-root' }]
                : [])
        ];
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

    return {
        componentScopePath,
        componentScope,
        componentFolderPath,
        canvasJsPath,
        updateDiagnostics,
        componentResources,
        renderedInput,
        watchedPaths,
        findLeafComponentByPath,
        findAnyByPath,
        validateCanvasConfig
    };
};

module.exports = {
    createCanvasGraph
};
