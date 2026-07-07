# LiquidOS desktop (Electron)

The cross-platform wrapper — the sibling of `mac-app/LiquidOSApp.swift`. It does the
same job the Mac app does (open/create a `.liquidos` workspace, spawn and supervise
`server.js`, show the canvas, restart-and-recover on a crash), but runs anywhere
Electron does. The point of it is to be a **real app in the ChromeOS launcher**,
running inside the Linux (Crostini) container.

## What it does (parity with the Mac app)

| Responsibility | Here |
|---|---|
| Pick a free localhost port | `freePort()` |
| Spawn `node server.js --workspace … --agent … --port …` | `startServer()` |
| Open / create a `.liquidos` workspace | native dialogs + chooser page |
| Load the canvas when the server answers | `loadWhenReady()` |
| Restart + recovery loop on crash (rate-limited) | `startServer()` exit handler |
| Live `/recovery` page → canvas on `state:"ready"` | `loadRecoveryWhenReady()` |
| Escape → `window.liquidos.handleEscape()` | `before-input-event` |
| External links → default browser | `setWindowOpenHandler` / `will-navigate` |
| `LIQUIDOS_NATIVE_NOTIFICATION` → OS toast | `handleServerOutputLine()` |

**The one difference from the Mac app — where Node comes from.** The server *core*
is the compiled Go binary (`go-server/liquidos-server`); the only JS left is the
`server.js` shim and the agent sidecar the Go server spawns, and both use just Node
built-ins (no native modules). So:

- **Packaged** (AppImage/.deb): no system Node needed — the wrapper runs that JS on
  Electron's own bundled Node (`ELECTRON_RUN_AS_NODE`), so the app is self-contained.
- **From source**: it spawns the `node` on your `PATH`.

Override either with `LIQUIDOS_NODE`.

## Run it

From the repo root, once (installs the server's own deps against the container Node):

```sh
npm install
```

Then in `electron-app/`:

```sh
npm install      # pulls Electron
npm start        # opens the chooser
# or jump straight into a workspace:
npm start -- /path/to/Workspace.liquidos
```

Works the same on macOS for development — Electron is cross-platform.

## Setup on a Chromebook (from source)

1. **Settings → Advanced → Developers → Linux development environment** → turn on.
2. In the Linux terminal: install Node 18+ (`sudo apt install nodejs npm`, or nvm).
3. Clone the repo, then in `electron-app/` run `npm install`.
4. Build the Go server once: `(cd ../go-server && go build -o liquidos-server .)`.
5. `npm start` — it appears as its own window.

## Package it (single AppImage / .deb, double-click install)

`npm run dist` produces a self-contained AppImage and `.deb` — **no terminal, no
`apt install nodejs`**: the app carries Electron's Node, and `dist` cross-compiles
the Go server for Linux and bundles it. The whole server payload (the Go binary,
`server.js`, `index.html`, `agent/`, `lib/`, `skills/`) lands under
`resources/app-root/`; `main.js` points `LIQUIDOS_APP_ROOT` there when packaged.

`dist` = `build:server` (Go → `linux/amd64` + `linux/arm64`, `CGO_ENABLED=0` so no
toolchain fuss) **then** `electron-builder --linux` (AppImage + `.deb`, x64 + arm64).
Both steps run in one shot — the Linux packages have no separate host build step.

### Building the Linux packages

The build runs entirely inside Linux, so it's identical on a Linux box, in CI, or on
a Mac. It needs electron-builder's toolchain (`fpm`/`dpkg`) **and** Go; the committed
`Dockerfile` bundles both into a `liquidos-builder` image, so one `docker run` builds
everything. On macOS, [Colima](https://github.com/abiosoft/colima) gives you Docker
without Docker Desktop:

```sh
brew install colima docker
colima start --vm-type=vz --vz-rosetta          # one-time; `colima start` to resume

# from the repo root:
docker build -t liquidos-builder electron-app   # one-time: Node + fpm + Go
docker run --rm -v "$PWD":/project -w /project/electron-app \
  liquidos-builder sh -c "npm install && npm run dist"
# → electron-app/dist/*.AppImage and *.deb  (visible straight from macOS)
```

Rebuild the image only when the Dockerfile changes; otherwise just re-run the second
command (`colima start` first if the VM is stopped).

`npm run dist` builds **both** arches (four files: x64 + arm64 × AppImage + `.deb`) —
the arches are pinned in `build.linux.target` in `package.json`, so a CLI `--x64` /
`--arm64` flag won't narrow it; drop an arch from those arrays to build just one.

**Match the arch to the Chromebook:** most Crostini containers are `x64`; ARM
Chromebooks are `arm64`. Install a `.deb` with `sudo apt install ./liquidos-desktop_*.deb`;
`chmod +x` an AppImage and double-click.

### Or, run from source with a launcher entry

Crostini surfaces Linux `.desktop` entries in the ChromeOS launcher. Drop this at
`~/.local/share/applications/liquidos.desktop` (edit the paths) to get a launcher icon
without packaging:

```ini
[Desktop Entry]
Type=Application
Name=LiquidOS
Exec=sh -c "cd $HOME/LiquidOS/electron-app && npm start"
Icon=/home/USER/LiquidOS/electron-app/build/icon.png
Terminal=false
Categories=Development;
```

## Config

| Env var | Default | Purpose |
|---|---|---|
| `LIQUIDOS_NODE` | `node` | Node binary used to run the server |
| `LIQUIDOS_APP_ROOT` | repo root | Where `server.js` lives |
| `LIQUIDOS_AGENT` | hermes,pi,codex,claude | Comma-separated agent roster override |
