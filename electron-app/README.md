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

**The one difference from the Mac app:** it doesn't bundle Node. On ChromeOS the
repo's native modules (`@parcel/watcher`, …) are compiled by `npm install` against
the container's system Node, so the server must run on that same Node. So: install
Node in Crostini, and this wrapper spawns it (override with `LIQUIDOS_NODE`).

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

## Setup on a Chromebook

1. **Settings → Advanced → Developers → Linux development environment** → turn on.
2. In the Linux terminal: install Node 18+ (`sudo apt install nodejs npm`, or nvm).
3. Clone the repo, `npm install` at the root, then `cd electron-app && npm install`.
4. `npm start` — it appears as its own window.

## Make it a launcher app (the "nice wrapper" part)

Crostini surfaces Linux `.desktop` entries in the ChromeOS launcher and shelf with
their own icon. Drop this at `~/.local/share/applications/liquidos.desktop` (edit the
paths), then it shows up in the launcher like any Chromebook app:

```ini
[Desktop Entry]
Type=Application
Name=LiquidOS
Exec=sh -c "cd $HOME/LiquidOS/electron-app && npm start"
Icon=/home/USER/LiquidOS/mac-app/LiquidOS-icon.svg
Terminal=false
Categories=Development;
MimeType=inode/directory;
```

For a packaged single binary later, add [electron-builder](https://www.electron.build/)
(`target: AppImage` or `deb`) — but running from source as above is enough to get the
launcher icon and standalone window.

## Config

| Env var | Default | Purpose |
|---|---|---|
| `LIQUIDOS_NODE` | `node` | Node binary used to run the server |
| `LIQUIDOS_APP_ROOT` | repo root | Where `server.js` lives |
| `LIQUIDOS_AGENT` | hermes,pi,codex,claude | Comma-separated agent roster override |
