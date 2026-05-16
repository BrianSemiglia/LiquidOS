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

    const resourceUrl = (componentPath, name) =>
        '/component/' + encodeURIComponent(componentScopePath(componentPath)) + '/resources/' + encodeURIComponent(name);

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
            '<button data-live-prompt="' +
            escapeHTML(
                'The component at path ' +
                componentScopePath(componentPath) +
                ' has invalid JSON. Please repair.'
            ) +
            '" style="justify-self:start;border:1px solid rgba(252,165,165,0.35);border-radius:999px;background:rgba(127,29,29,0.55);color:#fecaca;padding:0.55rem 0.85rem;font:inherit;font-weight:700;cursor:pointer;">Repair it</button>' +
            '</div>',
        css: ''
    });

    const loadLeafComponent = entry => {
        try {
            return {
                ...entry,
                component: readJson(entry.componentPath)
            };
        } catch (error) {
            return {
                ...entry,
                component: invalidComponentCard(entry.componentPath, error)
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

    const findLeafComponentByScope = scopePath => {
        if (!scopePath) {
            return null;
        }

        const absolute = resolveCanvasReference(scopePath);

        return leafComponents().find(entry =>
            entry.componentPath === scopePath
            || entry.componentPath === absolute
            || componentScopePath(entry.componentPath) === scopePath
        ) || null;
    };

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

    const renderedResources = (componentPath, resources) =>
        Object.fromEntries(
            Object.entries(resources).map(([name, resource]) => [
                name,
                {
                    ...resource,
                    url: resourceUrl(componentPath, name)
                }
            ])
        );

    const renderedHtml = (componentPath, component, resources) =>
        (component.css ? '<style>' + String(component.css) + '</style>' : '')
        + String(component.html || '')
            .replaceAll('data-input-file', 'src="' + componentFileUrl(componentPath) + '"')
            .replace(/\{\{\s*componentPath\s*\}\}/g, componentScopePath(componentPath))
            .replace(/\{\{\s*componentFolder\s*\}\}/g, componentScopePath(componentPath))
            .replace(/\{\{\s*resources\.(.+?)\.url\s*\}\}/g, (match, name) =>
                resources[name.trim()] ? resourceUrl(componentPath, name.trim()) : match
            );

    const renderedInput = () => ({
        canvasPath: getCanvasPath(),
        ...readJson(getInputPath()),
        components: leafComponents().map(({ index, componentPath, component }) => {
            const resources = componentResources(component);

            return {
                ...component,
                index,
                componentPath,
                resources: renderedResources(componentPath, resources),
                file: component.file ? componentFileUrl(componentPath) : undefined,
                html: renderedHtml(componentPath, component, resources)
            };
        })
    });

    const watchedFiles = () =>
        Array.from(new Set([
            getInputPath(),
            ...leafComponents().flatMap(({ componentPath, component }) =>
                [
                    componentPath,
                    component.file,
                    ...Object.values(componentResources(component)).map(resource => resource.path)
                ].filter(Boolean)
            )
        ]));

    const validateComponentFile = componentPath => {
        const component = readJson(componentPath);
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

    return {
        componentScopePath,
        componentFileUrl,
        resourceUrl,
        componentResources,
        renderedResources,
        renderedHtml,
        renderedInput,
        watchedFiles,
        inputEntries,
        leafComponents,
        findLeafComponentByScope,
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
