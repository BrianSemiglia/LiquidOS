const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const COMPONENT_PATH = '~/Documents/Music/to the metal/component.json';

const clients = [];

function broadcastReload() {
    for (const res of clients) {
        res.write('data: reload\n\n');
    }
}

const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url);

    if (parsed.pathname === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        clients.push(res);
        req.on('close', () => {
            const i = clients.indexOf(res);
            if (i !== -1) clients.splice(i, 1);
        });
        return;
    }

    if (parsed.pathname === '/component') {
        const data = fs.readFileSync(COMPONENT_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(data);
        return;
    }

    if (parsed.pathname === '/mp3') {
        try {
            const comp = JSON.parse(fs.readFileSync(COMPONENT_PATH, 'utf8'));
            if (!comp || !comp.file) {
                res.writeHead(404);
                res.end('No file in component');
                return;
            }
            const mp3Path = comp.file; // Already absolute
            const stat = fs.statSync(mp3Path);
            res.writeHead(200, {
                'Content-Type': 'audio/mpeg',
                'Content-Length': stat.size,
                'Cache-Control': 'no-cache'
            });
            fs.createReadStream(mp3Path).pipe(res);
        } catch (e) {
            res.writeHead(404);
            res.end('File not found: ' + e.message);
        }
        return;
    }

    // Serve canvas from server's directory
    const filePath = path.join(__dirname, parsed.pathname === '/' ? 'index.html' : parsed.pathname);
    console.log('Trying to read:', filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.log('Error reading file:', err.message);
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
        res.end(data);
    });
});

server.listen(3000, () => console.log('Server at http://localhost:3000'));

function watchDir(dir) {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) watchDir(fullPath);
            else fs.watch(fullPath, () => broadcastReload());
        }
    } catch (e) {
        console.error('watchDir error:', e.message);
    }
}

// Watch server directory and component directory
watchDir(__dirname);
watchDir(path.dirname(COMPONENT_PATH));