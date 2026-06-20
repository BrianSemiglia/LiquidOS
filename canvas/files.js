const path = require('path');

const createCanvasFiles = ({
    fs,
    workspacePath,
    canvasTemplateRoot,
    localAssetRoot = path.dirname(workspacePath),
    getCanvasPath,
    setCanvasPath,
    readJson
}) => {
    const copyTemplateDirectory = (source, target) => {
        fs.mkdirSync(target, { recursive: true });

        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            if (entry.name === '.gitkeep' || entry.name === 'canvas.html') {
                continue;
            }

            const sourcePath = path.join(source, entry.name);
            const targetPath = path.join(target, entry.name);

            if (entry.isDirectory()) {
                copyTemplateDirectory(sourcePath, targetPath);
            } else if (entry.isFile() && !fs.existsSync(targetPath)) {
                fs.copyFileSync(sourcePath, targetPath);
            }
        }
    };

    const writeDefaultFile = (filePath, contents) => {
        if (!fs.existsSync(filePath)) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, contents);
        }
    };

    const copyLocalAssetDirectory = (sourceName, canvasPath) => {
        const sourcePath = path.join(localAssetRoot, sourceName);
        const targetPath = path.join(canvasPath, sourceName);

        if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
            copyTemplateDirectory(sourcePath, targetPath);
        }
    };

    const ensureLocalAssetReferences = canvasPath => {
        const indexPath = path.join(canvasPath, 'index.json');

        if (!fs.existsSync(indexPath)) {
            return;
        }

        try {
            const input = readJson(indexPath);

            if (typeof input.presentation !== 'string' || !input.presentation.trim()) {
                fs.writeFileSync(indexPath, JSON.stringify({
                    ...input,
                    presentation: 'presentations/stack.js'
                }, null, 2) + '\n');
            }
        } catch (error) {
            // A damaged index.json is a canvas-level repair case. Startup/default
            // materialization must not throw before the web UI can render that card.
        }
    };

    const ensureCanvasDefaults = name => {
        const canvasPath = path.join(workspacePath, name);

        fs.mkdirSync(canvasPath, { recursive: true });

        if (fs.existsSync(canvasTemplateRoot)) {
            copyTemplateDirectory(canvasTemplateRoot, canvasPath);
        }

        fs.mkdirSync(path.join(canvasPath, 'components'), { recursive: true });
        copyLocalAssetDirectory('presentations', canvasPath);

        writeDefaultFile(
            path.join(canvasPath, 'index.json'),
            JSON.stringify({
                components: [],
                presentation: 'presentations/stack.js'
            }, null, 2) + '\n'
        );
        ensureLocalAssetReferences(canvasPath);

        return canvasPath;
    };

    const availableCanvases = () =>
        fs.existsSync(workspacePath)
            ? fs.readdirSync(workspacePath, { withFileTypes: true })
                .filter(entry =>
                    entry.isDirectory() &&
                    !entry.name.startsWith('.') &&
                    fs.existsSync(path.join(workspacePath, entry.name, 'index.json'))
                )
                .map(entry => {
                    const canvasPath = path.join(workspacePath, entry.name);

                    return {
                        name: entry.name,
                        path: canvasPath,
                        current: canvasPath === getCanvasPath(),
                        valid: true
                    };
                })
            : [];

    const switchCanvas = name => {
        if (!/^[^/][^/]*$/.test(name)) {
            const error = new Error('Invalid canvas name');
            error.statusCode = 400;
            throw error;
        }

        const canvasPath = path.join(workspacePath, name);

        if (!fs.existsSync(path.join(canvasPath, 'index.json'))) {
            const error = new Error('Canvas does not exist: ' + name);
            error.statusCode = 404;
            throw error;
        }

        setCanvasPath(canvasPath);
    };

    const createCanvas = name => {
        const safeName = String(name || '').trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '');

        if (!safeName) {
            const error = new Error('Canvas name is required');
            error.statusCode = 400;
            throw error;
        }

        if (fs.existsSync(path.join(workspacePath, safeName))) {
            const error = new Error('Canvas already exists: ' + safeName);
            error.statusCode = 409;
            throw error;
        }

        const canvasPath = ensureCanvasDefaults(safeName);
        // feature-requirements.txt is a plain-text description of what this
        // canvas is for. Materialized empty at creation time only — startup
        // bootstrap leaves it alone so a deleted/missing file stays missing
        // (UI distinguishes missing → Repair from empty → Generate).
        fs.writeFileSync(path.join(canvasPath, 'feature-requirements.txt'), '');
        return safeName;
    };

    return {
        ensureCanvasDefaults,
        availableCanvases,
        switchCanvas,
        createCanvas
    };
};

module.exports = {
    createCanvasFiles
};
