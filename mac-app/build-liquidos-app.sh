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
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key>
      <string>LiquidOS Workspace</string>
      <key>CFBundleTypeRole</key>
      <string>Editor</string>
      <key>LSHandlerRank</key>
      <string>Owner</string>
      <key>LSTypeIsPackage</key>
      <true/>
      <key>CFBundleTypeExtensions</key>
      <array>
        <string>liquidos</string>
      </array>
      <key>LSItemContentTypes</key>
      <array>
        <string>local.liquidos.workspace</string>
        <string>com.apple.package</string>
      </array>
    </dict>
  </array>
  <key>UTExportedTypeDeclarations</key>
  <array>
    <dict>
      <key>UTTypeIdentifier</key>
      <string>local.liquidos.workspace</string>
      <key>UTTypeDescription</key>
      <string>LiquidOS Workspace</string>
      <key>UTTypeConformsTo</key>
      <array>
        <string>com.apple.package</string>
        <string>public.directory</string>
      </array>
      <key>UTTypeTagSpecification</key>
      <dict>
        <key>public.filename-extension</key>
        <array>
          <string>liquidos</string>
        </array>
      </dict>
    </dict>
  </array>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSBluetoothAlwaysUsageDescription</key>
  <string>LiquidOS uses Bluetooth access for local components that display and control Bluetooth device state.</string>
  <key>NSBluetoothPeripheralUsageDescription</key>
  <string>LiquidOS uses Bluetooth access for local components that display and control Bluetooth device state.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>LiquidOS uses microphone access for local components that display live microphone activity.</string>
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

if [ ! -f "$PROJECT_ROOT/skills/AGENTS.md" ]; then
  echo "Error: skills/AGENTS.md is required." >&2
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/skills/component-creator/SKILL.md" ]; then
  echo "Error: skills/component-creator/SKILL.md is required." >&2
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/skills/canvas-creator/SKILL.md" ]; then
  echo "Error: skills/canvas-creator/SKILL.md is required." >&2
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/skills/canvas-creator/scripts/create-instance.sh" ]; then
  echo "Error: skills/canvas-creator/scripts/create-instance.sh is required." >&2
  exit 1
fi

mkdir -p "$RESOURCES/canvases"

# Hermes is not bundled. LiquidOS uses the user-installed `hermes` found on PATH.
if [ -f "$RESOURCES/package.json" ]; then
 npm install --prefix "$RESOURCES" --omit=dev
 # Fix execute permissions for node-pty spawn-helper
 find "$RESOURCES/node_modules/node-pty/prebuilds" -name 'spawn-helper' -exec chmod +x {} \;
fi

chmod +x "$MACOS/LiquidOS"
echo "Built: $APP"
echo "Open with: open '$APP'"
