const path = require('path');

const createCanvasFiles = ({
    fs,
    canvasesRoot,
    canvasTemplateRoot,
    getCanvasPath,
    setCanvasPath,
    readJson
}) => {
    const copyTemplateDirectory = (source, target) => {
        fs.mkdirSync(target, { recursive: true });

        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            if (entry.name === '.gitkeep') {
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

    const ensureCanvasDefaults = name => {
        const canvasPath = path.join(canvasesRoot, name);

        fs.mkdirSync(canvasPath, { recursive: true });

        if (fs.existsSync(canvasTemplateRoot)) {
            copyTemplateDirectory(canvasTemplateRoot, canvasPath);
        }

        fs.mkdirSync(path.join(canvasPath, 'components'), { recursive: true });

        writeDefaultFile(
            path.join(canvasPath, 'input.json'),
            JSON.stringify({ components: [], css: 'body{background:#0b1120}' }, null, 2) + '\n'
        );
        writeDefaultFile(path.join(canvasPath, 'output.json'), '[]\n');
        writeDefaultFile(
            path.join(canvasPath, 'canvas.html'),
            `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blank Canvas</title>
  <style>
    html, body {
      margin: 0;
      min-height: 100%;
      background: #0b1120;
    }
  </style>
</head>
<body></body>
</html>
`
        );

        return canvasPath;
    };

    const availableCanvases = () =>
        fs.existsSync(canvasesRoot)
            ? fs.readdirSync(canvasesRoot, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
                .map(entry => {
                    const canvasPath = path.join(canvasesRoot, entry.name);

                    return {
                        name: entry.name,
                        path: canvasPath,
                        current: canvasPath === getCanvasPath(),
                        valid: fs.existsSync(path.join(canvasPath, 'input.json'))
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
            ensureCanvasDefaults(name);
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
