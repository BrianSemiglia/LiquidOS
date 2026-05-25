const path = require('path');

const createCanvasFiles = ({
    fs,
    canvasesRoot,
    canvasTemplateRoot,
    localAssetRoot = path.dirname(canvasesRoot),
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
        const inputPath = path.join(canvasPath, 'input.json');

        if (!fs.existsSync(inputPath)) {
            return;
        }

        const input = readJson(inputPath);

        if (typeof input.presentation !== 'string' || !input.presentation.trim()) {
            input.presentation = 'presentations/stack.css';
        }

        fs.writeFileSync(inputPath, JSON.stringify(input, null, 2) + '\n');
    };

    const ensureCanvasDefaults = name => {
        const canvasPath = path.join(canvasesRoot, name);

        fs.mkdirSync(canvasPath, { recursive: true });

        if (fs.existsSync(canvasTemplateRoot)) {
            copyTemplateDirectory(canvasTemplateRoot, canvasPath);
        }

        fs.mkdirSync(path.join(canvasPath, 'components'), { recursive: true });
        copyLocalAssetDirectory('presentations', canvasPath);

        writeDefaultFile(
            path.join(canvasPath, 'input.json'),
            JSON.stringify({
                components: [],
                presentation: 'presentations/stack.css'
            }, null, 2) + '\n'
        );
        ensureLocalAssetReferences(canvasPath);

        writeDefaultFile(path.join(canvasPath, 'output.json'), '[]\n');

        return canvasPath;
    };

    const availableCanvases = () =>
        fs.existsSync(canvasesRoot)
            ? fs.readdirSync(canvasesRoot, { withFileTypes: true })
                .filter(entry =>
                    entry.isDirectory() &&
                    !entry.name.startsWith('.') &&
                    fs.existsSync(path.join(canvasesRoot, entry.name, 'input.json'))
                )
                .map(entry => {
                    const canvasPath = path.join(canvasesRoot, entry.name);

                    return {
                        name: entry.name,
                        path: canvasPath,
                        current: canvasPath === getCanvasPath(),
                        valid: true
                    };
                })
            : [];

    const readCanvasInputAt = canvasPath =>
        readJson(path.join(canvasPath, 'input.json'));

    const switchCanvas = name => {
        if (!/^[^/][^/]*$/.test(name)) {
            const error = new Error('Invalid canvas name');
            error.statusCode = 400;
            throw error;
        }

        const canvasPath = path.join(canvasesRoot, name);

        if (!fs.existsSync(path.join(canvasPath, 'input.json'))) {
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

        if (fs.existsSync(path.join(canvasesRoot, safeName))) {
            const error = new Error('Canvas already exists: ' + safeName);
            error.statusCode = 409;
            throw error;
        }

        ensureCanvasDefaults(safeName);
        return safeName;
    };

    return {
        ensureCanvasDefaults,
        availableCanvases,
        readCanvasInputAt,
        switchCanvas,
        createCanvas
    };
};

module.exports = {
    createCanvasFiles
};
