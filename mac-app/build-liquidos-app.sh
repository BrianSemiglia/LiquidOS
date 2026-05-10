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
  --exclude 'canvases/*' \
  "$PROJECT_ROOT/" "$WEB/"

mkdir -p "$WEB/canvases"

chmod +x "$MACOS/LiquidOS"
echo "Built: $APP"
echo "Open with: open '$APP'"
