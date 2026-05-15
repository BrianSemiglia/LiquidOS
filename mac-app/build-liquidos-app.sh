#!/bin/zsh
set -euo pipefail

MAC_ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$MAC_ROOT/.." && pwd)"
APP="$MAC_ROOT/build/LiquidOS.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
ICONSET="$MAC_ROOT/LiquidOS.iconset"

rm -rf "$APP"
mkdir -p "$MACOS" "$RESOURCES"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>LiquidOS</string>
  <key>CFBundleDisplayName</key>
  <string>LiquidOS</string>
  <key>CFBundleExecutable</key>
  <string>LiquidOS</string>
  <key>CFBundleIdentifier</key>
  <string>local.liquidos.app</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>LiquidOS</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

xcrun swiftc \
  "$MAC_ROOT/LiquidOSApp.swift" \
  -o "$MACOS/LiquidOS" \
  -framework Cocoa \
  -framework WebKit

if [ -d "$ICONSET" ]; then
  iconutil -c icns "$ICONSET" -o "$RESOURCES/LiquidOS.icns"
else
  echo "Warning: $ICONSET missing; building without custom icon."
fi

rsync -a \
  --exclude '.git' \
  --exclude '__MACOSX' \
  --exclude '.DS_Store' \
  --exclude 'build' \
  --exclude 'mac-app' \
  --exclude 'node_modules' \
  --exclude 'canvases/*' \
  "$PROJECT_ROOT/" "$RESOURCES/"

if [ -d "$MAC_ROOT/.hermes" ]; then
  mkdir -p "$RESOURCES/.hermes"
  rsync -a "$MAC_ROOT/.hermes/" "$RESOURCES/.hermes/"
fi

mkdir -p "$RESOURCES/canvases"

PYTHON_VERSION="3.11"
HERMES_SOURCE_ARCHIVE="$MAC_ROOT/vendor/hermes-agent-8e2eb4b511967a0ad776c0c667f6914072e1b7ec.tar.gz"

if ! command -v uv >/dev/null 2>&1; then
  echo "Error: uv is required to build the bundled Hermes artifact." >&2
  exit 1
fi

if [ ! -f "$HERMES_SOURCE_ARCHIVE" ]; then
  echo "Error: bundled Hermes source archive is missing: $HERMES_SOURCE_ARCHIVE" >&2
  exit 1
fi

HERMES_BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/liquidos-hermes-build.XXXXXX")"
HERMES_SOURCE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/liquidos-hermes-source.XXXXXX")"
trap 'rm -rf "$HERMES_BUILD_ROOT" "$HERMES_SOURCE_ROOT"' EXIT

HERMES_BUNDLE_ROOT="$RESOURCES/Hermes"

tar -xzf "$HERMES_SOURCE_ARCHIVE" -C "$HERMES_SOURCE_ROOT"

uv python install --managed-python "$PYTHON_VERSION"
UV_MANAGED_PYTHON_BIN="$(uv python find --managed-python "$PYTHON_VERSION")"
UV_MANAGED_PYTHON_PREFIX="$(dirname "$(dirname "$UV_MANAGED_PYTHON_BIN")")"

uv venv "$HERMES_BUILD_ROOT/venv" --python "$UV_MANAGED_PYTHON_BIN"
(
  cd "$HERMES_SOURCE_ROOT/hermes-agent"
  uv build --wheel --out-dir "$HERMES_BUILD_ROOT/dist"
)
uv pip install --python "$HERMES_BUILD_ROOT/venv/bin/python" "$HERMES_BUILD_ROOT"/dist/hermes_agent-*.whl

mkdir -p "$HERMES_BUNDLE_ROOT"
mkdir -p "$HERMES_BUNDLE_ROOT/python"
rsync -a "$UV_MANAGED_PYTHON_PREFIX/" "$HERMES_BUNDLE_ROOT/python/"
mkdir -p "$HERMES_BUNDLE_ROOT/site-packages"
rsync -a "$HERMES_BUILD_ROOT/venv/lib/python3.11/site-packages/" "$HERMES_BUNDLE_ROOT/site-packages/"

cat > "$HERMES_BUNDLE_ROOT/hermes" <<'SH'
#!/bin/sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$DIR/.." && pwd)"
export PYTHONPATH="$DIR/site-packages${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONNOUSERSITE=1
export HERMES_HOME="$HOME/Library/Application Support/LiquidOS/Hermes"
mkdir -p "$HERMES_HOME"
if [ -f "$APP_ROOT/.hermes/SOUL.md" ]; then
  cp -f "$APP_ROOT/.hermes/SOUL.md" "$HERMES_HOME/SOUL.md"
fi
exec "$DIR/python/bin/python3.11" -m hermes_cli.main "$@"
SH
chmod +x "$HERMES_BUNDLE_ROOT/hermes"

if [ -f "$RESOURCES/package.json" ]; then
 npm install --prefix "$RESOURCES" --omit=dev
 # Fix execute permissions for node-pty spawn-helper
 find "$RESOURCES/node_modules/node-pty/prebuilds" -name 'spawn-helper' -exec chmod +x {} \;
fi

chmod +x "$MACOS/LiquidOS"
echo "Built: $APP"
echo "Open with: open '$APP'"
