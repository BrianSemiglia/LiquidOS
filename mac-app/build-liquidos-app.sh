#!/bin/zsh
set -euo pipefail

MAC_ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$MAC_ROOT/.." && pwd)"
APP="$MAC_ROOT/build/LiquidOS.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
WEB="$RESOURCES/Web"
ICONSET="$MAC_ROOT/LiquidOS.iconset"

rm -rf "$APP"
mkdir -p "$MACOS" "$RESOURCES" "$WEB"

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
  "$PROJECT_ROOT/" "$WEB/"

mkdir -p "$WEB/canvases"

if command -v hermes >/dev/null 2>&1; then
  HERMES_SOURCE_ROOT="$(dirname "$(dirname "$(dirname "$(realpath "$(command -v hermes)")")")")"
  HERMES_BUNDLE_ROOT="$WEB/Hermes"
  HERMES_PYTHON_PREFIX="/opt/homebrew/Cellar/python@3.11/3.11.15_1"

  if ! command -v uv >/dev/null 2>&1; then
    echo "Error: uv is required to build the bundled Hermes artifact." >&2
    exit 1
  fi

  HERMES_BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/liquidos-hermes-build.XXXXXX")"
  trap 'rm -rf "$HERMES_BUILD_ROOT"' EXIT

  mkdir -p "$HERMES_BUNDLE_ROOT"
  (
    cd "$HERMES_SOURCE_ROOT"
    uv build --wheel --out-dir "$HERMES_BUILD_ROOT/dist"
  )
  uv venv "$HERMES_BUILD_ROOT/venv" --python 3.11
  uv pip install --python "$HERMES_BUILD_ROOT/venv/bin/python" "$HERMES_BUILD_ROOT"/dist/hermes_agent-*.whl

  rsync -a "$HERMES_PYTHON_PREFIX/" "$HERMES_BUNDLE_ROOT/python/"
  mkdir -p "$HERMES_BUNDLE_ROOT/site-packages"
  rsync -a "$HERMES_BUILD_ROOT/venv/lib/python3.11/site-packages/" "$HERMES_BUNDLE_ROOT/site-packages/"

  cat > "$HERMES_BUNDLE_ROOT/hermes" <<'SH'
#!/bin/sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONHOME="$DIR/python/Frameworks/Python.framework/Versions/3.11"
export PYTHONPATH="$DIR/site-packages${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONNOUSERSITE=1
export HERMES_HOME="$HOME/Library/Application Support/LiquidOS/Hermes"
mkdir -p "$HERMES_HOME"
exec "$DIR/python/bin/python3.11" -m hermes_cli.main "$@"
SH
  chmod +x "$HERMES_BUNDLE_ROOT/hermes"
else
  echo "Error: hermes is required to build the bundled fallback artifact." >&2
  exit 1
fi

if [ -f "$WEB/package.json" ]; then
 npm install --prefix "$WEB" --omit=dev
 # Fix execute permissions for node-pty spawn-helper
 find "$WEB/node_modules/node-pty/prebuilds" -name 'spawn-helper' -exec chmod +x {} \;
fi

chmod +x "$MACOS/LiquidOS"
echo "Built: $APP"
echo "Open with: open '$APP'"
