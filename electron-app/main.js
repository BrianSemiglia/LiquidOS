'use strict';

// LiquidOS desktop wrapper — the cross-platform port of mac-app/LiquidOSApp.swift.
//
// Same job as the Mac app: it is a process supervisor with a webview face. It
//   1. picks a free localhost port,
//   2. spawns `go-server/liquidos-server --workspace <ws> --agent … --port <p>` and pipes it,
//   3. shows an app-owned chooser to open/create a `.liquidos` workspace,
//   4. loads the canvas once the server answers on 127.0.0.1:<port>,
//   5. supervises the server: on an unexpected exit it restarts (rate-limited),
//      shows a recovery gap screen, then the server's live /recovery page, and
//      returns to the canvas when the server reports `state: "ready"`,
//   6. routes external links to the default browser, forwards Escape to the
//      harness, and surfaces `LIQUIDOS_NATIVE_NOTIFICATION` lines as OS toasts.
//
// The one structural difference from the Mac app is where Node comes from.
// Packaged (AppImage/.deb, see package.json "build"), there is no system Node —
// and none is needed: the server core is the bundled Go binary, launched
// directly. The only JS left is the agent sidecar the Go server spawns; the
// packaged app runs that on Electron's own bundled Node via ELECTRON_RUN_AS_NODE
// (LIQUIDOS_NODE) and stays self-contained. From source the sidecar runs on the
// `node` on PATH. Override with LIQUIDOS_NODE.

const { app, BrowserWindow, dialog, shell, Menu, Notification, nativeTheme, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

// The repo root (where go-server/ lives). From source this is the parent of
// electron-app/; when packaged it's the `app-root/` payload electron-builder
// copies into the app's resources (package.json "build" extraResources).
// Override either layout with LIQUIDOS_APP_ROOT.
const APP_ROOT = process.env.LIQUIDOS_APP_ROOT
    || (app.isPackaged ? path.join(process.resourcesPath, 'app-root') : path.resolve(__dirname, '..'));

// True when the Go server should run its Node sidecar on Electron's own bundled
// Node (packaged, with no LIQUIDOS_NODE override). serverEnvironment() then
// points LIQUIDOS_NODE at the Electron binary and sets ELECTRON_RUN_AS_NODE so
// it behaves as plain Node.
const usingElectronNode = () => app.isPackaged && !process.env.LIQUIDOS_NODE;

// The harness "desk" background, matched natively so unpainted web backing reads
// as one surface with the harness desk (dark = Slate, light = Mist) — mirrors
// the Swift deskColor. backgroundColor can't be a live dynamic color as on macOS,
// so we re-set it on nativeTheme changes.
const DESK = { dark: '#1a1c1f', light: '#e9ebf0' };

// The app owns the server's lifecycle, so when the server dies on its own the
// app brings it back. Recent crash times bound the restart rate so a server
// that dies the instant it boots can't spin forever. (Swift: crashWindowSeconds
// / maxCrashesInWindow / restartDelaySeconds.)
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 3;
const RESTART_DELAY_MS = 1000;

let win = null;
let serverProc = null;
let port = 0;
let canvasesRoot = null;
let pendingWorkspace = null;
let crashRecovering = false;   // true from crash until the server reports 'ready'
let serverCrashTimestamps = [];
let serverErrorBuffer = '';
let serverOutputBuffer = '';
let chooserMessage = null;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const deskColor = () => (nativeTheme.shouldUseDarkColors ? DESK.dark : DESK.light);

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 840,
        backgroundColor: deskColor(),
        title: 'LiquidOS',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.on('closed', () => { win = null; });

    // Escape is reserved for the harness: it toggles the prompt bar (and
    // dismisses an open overlay first). Intercept it before the page sees it —
    // the resilient native path the browser build can't have — then swallow it
    // so the canvas never gets a stray Escape. One action per physical press;
    // swallow OS auto-repeats without re-triggering. (Swift: installEscapeMonitor.)
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        if (input.key !== 'Escape') return;
        event.preventDefault();
        if (!input.isAutoRepeat) {
            win.webContents.executeJavaScript('window.liquidos?.handleEscape?.()').catch(() => {});
        }
    });

    // target="_blank" / window.open → default browser, never a new app window.
    win.webContents.setWindowOpenHandler(({ url }) => {
        openExternally(url);
        return { action: 'deny' };
    });

    // A user-clicked external link in the main frame → default browser. Local
    // server navigations and iframe/subresource loads are left alone (isExternalLink
    // excludes localhost), so an embedded third-party player still loads inline.
    win.webContents.on('will-navigate', (event, url) => {
        if (isExternalLink(url)) {
            event.preventDefault();
            openExternally(url);
        }
    });

    nativeTheme.on('updated', () => { if (win) win.setBackgroundColor(deskColor()); });
}

// External = a real web URL that isn't our local app server. (Swift: isExternalLink.)
function isExternalLink(u) {
    try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        return host !== '127.0.0.1' && host !== 'localhost';
    } catch {
        return false;
    }
}

const openExternally = (u) => { shell.openExternal(u); };

// ---------------------------------------------------------------------------
// Server supervision
// ---------------------------------------------------------------------------

// The PATH the server (and anything it spawns, e.g. `claude`) runs with — the
// user bin dirs where agent CLIs live, prepended to the inherited PATH. Node is
// not resolved through here; NODE_BIN is spawned directly. (Swift: launchPath.)
function launchPath() {
    const home = os.homedir();
    const dirs = [
        path.join(home, '.local', 'bin'),
        path.join(home, '.cargo', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        '/usr/local/bin', '/usr/local/sbin',
        '/usr/bin', '/bin', '/usr/sbin', '/sbin',
        '/opt/homebrew/bin', '/opt/homebrew/sbin',  // harmless on Linux; helps Mac dev
    ];
    const existing = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    return [...dirs, ...existing].join(path.delimiter);
}

function serverEnvironment() {
    const env = { ...process.env, LIQUIDOS_RUNTIME_KIND: 'electron-app', PATH: launchPath() };
    if (usingElectronNode()) {
        // Run the agent sidecar the Go server spawns on Electron's bundled Node.
        // LIQUIDOS_NODE points the Go server at that binary; ELECTRON_RUN_AS_NODE
        // makes it behave as plain Node rather than relaunching the app. Both
        // propagate down the chain: Electron → go-server → agent/sidecar.js.
        env.LIQUIDOS_NODE = process.execPath;
        env.ELECTRON_RUN_AS_NODE = '1';
    }
    return env;
}

// The agent roster is the array of --agent script paths; the first is the
// default-active. Override the roster (e.g. for a deterministic recovery stub in
// UI tests) with LIQUIDOS_AGENT, comma-separated. (Swift: agentScriptArgs.)
function agentScriptArgs() {
    const override = (process.env.LIQUIDOS_AGENT || '').trim();
    const scripts = override
        ? override.split(',').map((s) => s.trim()).filter(Boolean)
        : ['agent/hermes.js', 'agent/pi.js', 'agent/codex.js', 'agent/claude.js'];
    return scripts.flatMap((s) => ['--agent', s]);
}

function startServer() {
    if (!canvasesRoot) { showWorkspaceChooser(); return; }
    const serverBinary = path.join(APP_ROOT, 'go-server', 'liquidos-server');
    if (!fs.existsSync(serverBinary)) {
        showError('Missing server binary at ' + serverBinary + '.');
        return;
    }

    serverErrorBuffer = '';
    const args = ['--workspace', canvasesRoot, ...agentScriptArgs(), '--port', String(port)];
    const proc = spawn(serverBinary, args, { cwd: APP_ROOT, env: serverEnvironment() });
    serverProc = proc;

    proc.stdout.on('data', (d) => handleServerOutput(d.toString()));
    proc.stderr.on('data', (d) => { process.stderr.write(d); serverErrorBuffer += d.toString(); });

    proc.on('error', (err) => {
        showError('Could not start the LiquidOS server ("' + serverBinary + '").\n\n' + err.message);
    });

    // The server died on its own — almost always one component the agent wrote
    // taking it down. The app's only job is to restart it: the fresh boot is
    // where the server hands the crash to the agent (Phase 1, make it bootable),
    // then the permanent fix (Phase 2). If it crashes again we land right back
    // here; that recursion runs until the workspace boots clean. Give up only if
    // it keeps crashing faster than the repairs can help. `__intentional` marks a
    // process we killed ourselves (openWorkspace/quit) so its exit isn't a crash.
    proc.on('exit', (code) => {
        if (proc.__intentional) return;
        if (serverProc !== proc) return;
        serverProc = null;

        const now = Date.now();
        serverCrashTimestamps = serverCrashTimestamps.filter((t) => now - t < CRASH_WINDOW_MS);
        serverCrashTimestamps.push(now);

        if (serverCrashTimestamps.length > MAX_CRASHES_IN_WINDOW) {
            showError([
                'LiquidOS server keeps crashing and could not be recovered.',
                '',
                'Exit code: ' + code,
                '',
                serverErrorBuffer.trim() || 'No server error output was captured.',
            ].join('\n'));
            return;
        }

        // Show the gap screen now (only on the first crash of a sequence, so its
        // activity accumulates rather than flickering), then restart and swap to
        // the server's live /recovery page once it answers.
        if (!crashRecovering) {
            crashRecovering = true;
            showRecoveryScreen();
        }
        setTimeout(() => {
            if (serverProc) return;   // a newer start already took over
            startServer();
            loadRecoveryWhenReady(0);
        }, RESTART_DELAY_MS);
    });
}

function stopServer() {
    const proc = serverProc;
    if (!proc) return;
    proc.__intentional = true;   // its exit is expected, not a crash
    serverProc = null;
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
}

// Parse the server's stdout line-by-line for the two control channels it emits:
// LIQUIDOS_RECOVERY (bootable again) and LIQUIDOS_NATIVE_NOTIFICATION (OS toast).
function handleServerOutput(text) {
    process.stdout.write(text);
    serverOutputBuffer += text;
    let idx;
    while ((idx = serverOutputBuffer.indexOf('\n')) >= 0) {
        const line = serverOutputBuffer.slice(0, idx);
        serverOutputBuffer = serverOutputBuffer.slice(idx + 1);
        handleServerOutputLine(line);
    }
}

function handleServerOutputLine(line) {
    const RECOVERY = 'LIQUIDOS_RECOVERY ';
    if (line.startsWith(RECOVERY)) {
        let obj;
        try { obj = JSON.parse(line.slice(RECOVERY.length)); } catch { return; }
        // The workspace is bootable again — leave the recovery screen for the
        // canvas. (Phase 2, the permanent fix, keeps running in the background.)
        if (obj && obj.state === 'ready' && crashRecovering) {
            crashRecovering = false;
            loadWhenReady(0);
        }
        return;
    }

    const NOTIF = 'LIQUIDOS_NATIVE_NOTIFICATION ';
    if (!line.startsWith(NOTIF)) return;
    let obj;
    try { obj = JSON.parse(line.slice(NOTIF.length)); } catch { return; }
    if (Notification.isSupported()) {
        new Notification({ title: obj.title || 'LiquidOS', body: obj.body || '' }).show();
    }
}

// ---------------------------------------------------------------------------
// Loading the canvas / recovery page once the server answers
// ---------------------------------------------------------------------------

function pingServer(cb) {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        cb(res.statusCode === 200);
    });
    req.on('error', () => cb(false));
    req.setTimeout(2000, () => { req.destroy(); cb(false); });
}

function loadWhenReady(attempt) {
    if (attempt >= 120) {
        showError([
            'LiquidOS server did not answer on localhost port ' + port + '.',
            '',
            serverErrorBuffer.trim() || 'No server error output was captured.',
        ].join('\n'));
        return;
    }
    pingServer((ok) => {
        if (ok) win?.loadURL('http://127.0.0.1:' + port + '/');
        else setTimeout(() => loadWhenReady(attempt + 1), 150);
    });
}

// Once the restarted server answers, load its /recovery page (served same-origin
// so its EventSource('/agent/stream') connects and streams live agent activity;
// connecting there is also what releases Phase 1). Bails if recovery already
// finished (the canvas is loading). (Swift: loadRecoveryWhenReady.)
function loadRecoveryWhenReady(attempt) {
    if (!crashRecovering || attempt >= 120) return;
    pingServer((ok) => {
        if (!crashRecovering) return;
        if (ok) win?.loadURL('http://127.0.0.1:' + port + '/recovery');
        else setTimeout(() => loadRecoveryWhenReady(attempt + 1), 150);
    });
}

// ---------------------------------------------------------------------------
// Workspace open / create
// ---------------------------------------------------------------------------

const isWorkspacePath = (p) => p.toLowerCase().endsWith('.liquidos');

function receiveWorkspaceURL(p) {
    if (!win) { pendingWorkspace = p; return; }
    openWorkspace(p);
}

function openWorkspace(p) {
    if (!isWorkspacePath(p)) {
        chooserMessage = 'Workspaces must be .liquidos folders.';
        showWorkspaceChooser();
        return;
    }
    canvasesRoot = path.resolve(p);
    win?.setTitle(path.basename(p, path.extname(p)));
    showStartingScreen();
    stopServer();
    startServer();
    loadWhenReady(0);
}

async function showOpenWorkspacePanel() {
    const res = await dialog.showOpenDialog(win, {
        title: 'Open Workspace',
        buttonLabel: 'Open',
        properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return;
    openWorkspace(res.filePaths[0]);
}

async function showCreateWorkspacePanel() {
    const res = await dialog.showSaveDialog(win, {
        title: 'Create Workspace',
        buttonLabel: 'Create',
        defaultPath: 'Untitled.liquidos',
    });
    if (res.canceled || !res.filePath) return;
    const target = isWorkspacePath(res.filePath) ? res.filePath : res.filePath + '.liquidos';
    try {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(target, { recursive: true });
        openWorkspace(target);
    } catch (e) {
        chooserMessage = 'Could not create workspace.\n\n' + e.message;
        showWorkspaceChooser();
    }
}

// ---------------------------------------------------------------------------
// App-owned screens (rendered as data: URLs; the preload bridge is live on them)
// ---------------------------------------------------------------------------

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function loadHTML(html) {
    win?.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

const escapeHTML = (v) => String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// The chooser: theme-aware Open/Create, matching the harness blueprint look.
// Buttons post through the preload bridge (window.liquidosNative).
function showWorkspaceChooser() {
    const messageHTML = chooserMessage
        ? '<p class="error">' + escapeHTML(chooserMessage) + '</p>'
        : '';
    chooserMessage = null;
    loadHTML(`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root {
        color-scheme: light dark;
        --bg:#1a1c1f; --fg:#edeff2; --accent:#d4d7dc; --accent-hover:#e6e8ec;
        --accent-fg:#1a1c1f; --control:#2a2d31; --control-hover:#31343a;
        --err:rgba(239,68,68,0.22);
      }
      @media (prefers-color-scheme: light) {
        :root {
          --bg:#f4f5f7; --fg:#22262c; --accent:#3b4047; --accent-hover:#2c3037;
          --accent-fg:#ffffff; --control:#eceef2; --control-hover:#e3e6ec;
          --err:rgba(220,38,38,0.12);
        }
      }
      html,body { width:100%; height:100%; margin:0; background:var(--bg); }
      body { display:grid; place-items:center; color:var(--fg); font-family:${FONT};
             -webkit-font-smoothing:antialiased; }
      main { width:min(320px, calc(100vw - 48px)); }
      .error { margin:0 0 16px; padding:12px 14px; border-radius:12px;
               background:var(--err); color:var(--fg); line-height:1.4; white-space:pre-wrap; }
      .actions { display:grid; gap:10px; }
      button { width:100%; padding:12px 14px; border:0; border-radius:10px;
               background:var(--accent); color:var(--accent-fg); font:inherit;
               font-weight:600; cursor:pointer; }
      button:hover { background:var(--accent-hover); }
      button.secondary { background:var(--control); color:var(--fg); }
      button.secondary:hover { background:var(--control-hover); }
    </style></head>
    <body><main>
      ${messageHTML}
      <div class="actions">
        <button class="secondary" onclick="window.liquidosNative.open()">Open</button>
        <button onclick="window.liquidosNative.create()">Create</button>
      </div>
    </main></body></html>`);
}

function showStartingScreen() {
    loadHTML(`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light dark; --bg:#1a1c1f; --fg:rgba(237,239,242,0.7); }
      @media (prefers-color-scheme: light) { :root { --bg:#f4f5f7; --fg:rgba(34,38,44,0.6); } }
      html,body { width:100%; height:100%; margin:0; background:var(--bg); }
      body { display:grid; place-items:center; color:var(--fg); font-family:${FONT}; }
      .loading { letter-spacing:0.01em; font-weight:500; -webkit-font-smoothing:antialiased; }
    </style></head>
    <body><div class="loading" aria-label="Loading" role="status">Loading…</div></body></html>`);
}

// The gap screen: shown the instant the server crashes, while it restarts. A
// static app-owned page (the server is down right now, so it can't load
// anything). loadRecoveryWhenReady swaps to the server's live /recovery page
// once it answers. (Swift: showRecoveryScreen.)
function showRecoveryScreen() {
    loadHTML(`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: dark; }
      html,body { width:100%; height:100%; margin:0; background:#121212; }
      body { display:flex; flex-direction:column; box-sizing:border-box; height:100%;
             padding:0 48px; gap:14px; align-items:flex-start; justify-content:center;
             color:rgba(255,255,255,0.88); font-family:${FONT}; -webkit-font-smoothing:antialiased; }
      h1 { font-size:17px; font-weight:600; margin:0; }
      .sub { color:rgba(255,255,255,0.55); font-size:13px; margin:0; max-width:46ch; }
    </style></head>
    <body>
      <h1>Recovering from a crash…</h1>
      <p class="sub">Something took the workspace down. The agent is repairing it — your workspace will return when it's safe to load.</p>
    </body></html>`);
}

function showError(message) {
    loadHTML(`<!doctype html><html><body style="font-family:${FONT}; margin:48px; color:#121212; background:#f9fafb;">
      <h1>LiquidOS</h1>
      <pre style="white-space:pre-wrap; line-height:1.4;">${escapeHTML(message)}</pre>
    </body></html>`);
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu() {
    const isMac = process.platform === 'darwin';
    const template = [
        ...(isMac ? [{ role: 'appMenu' }] : []),
        {
            label: 'File',
            submenu: [
                { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: () => showOpenWorkspacePanel() },
                { label: 'Create Workspace…', accelerator: 'CmdOrCtrl+Shift+N', click: () => showCreateWorkspacePanel() },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { type: 'separator' },
                {
                    label: 'Toggle Debug Panel',
                    accelerator: 'CmdOrCtrl+Alt+D',
                    click: () => win?.webContents.executeJavaScript('window.liquidos?.toggleDebug?.()').catch(() => {}),
                },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        { role: 'windowMenu' },
    ];
    return Menu.buildFromTemplate(template);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// A `.liquidos` path passed on the command line (`electron . <ws>` or, when
// packaged, the file/protocol the launcher hands us). (Swift: startupWorkspaceURL.)
function workspaceArgFrom(argv) {
    return argv.find((a) => isWorkspacePath(a) && fs.existsSync(a)) || null;
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.setName('LiquidOS');

    app.on('second-instance', (_event, argv) => {
        const p = workspaceArgFrom(argv);
        if (p) receiveWorkspaceURL(p);
        if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    });

    // macOS: opening a .liquidos from Finder.
    app.on('open-file', (event, p) => { event.preventDefault(); receiveWorkspaceURL(p); });

    app.whenReady().then(() => {
        Menu.setApplicationMenu(buildMenu());
        freePort().then((p) => {
            port = p;
            createWindow();
            const startup = pendingWorkspace || workspaceArgFrom(process.argv);
            pendingWorkspace = null;
            if (startup) openWorkspace(startup);
            else showWorkspaceChooser();
        });
    });

    app.on('activate', () => { if (!win) createWindow(); });
    app.on('window-all-closed', () => { stopServer(); app.quit(); });
    app.on('before-quit', () => stopServer());
}

// A free localhost port, chosen once and reused across restarts. (Swift: freePort.)
function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.on('error', () => resolve(3000));
        srv.listen(0, '127.0.0.1', () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
        });
    });
}

ipcMain.on('workspace:open', () => showOpenWorkspacePanel());
ipcMain.on('workspace:create', () => showCreateWorkspacePanel());
