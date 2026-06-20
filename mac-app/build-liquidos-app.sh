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
  <key>NSMicrophoneUsageDescription</key>
  <string>LiquidOS uses microphone access only when a component you run asks to capture or analyze audio.</string>
  <key>NSCameraUsageDescription</key>
  <string>LiquidOS uses camera access only when a component you run asks to capture photos or video.</string>
  <key>NSBluetoothAlwaysUsageDescription</key>
  <string>LiquidOS uses Bluetooth access only when a component you run asks to discover or communicate with nearby Bluetooth devices.</string>
  <key>NSBluetoothPeripheralUsageDescription</key>
  <string>LiquidOS uses Bluetooth access only when a component you run asks to discover or communicate with nearby Bluetooth devices.</string>
  <key>NSLocalNetworkUsageDescription</key>
  <string>LiquidOS uses local network access only when a component you run asks to discover or serve devices on your network.</string>
  <key>NSBonjourServices</key>
  <array/>
  <key>NSLocationWhenInUseUsageDescription</key>
  <string>LiquidOS uses location access only when a component you run asks for your current location.</string>
  <key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
  <string>LiquidOS uses location access only when a component you run asks for location while the app is open or running.</string>
  <key>NSLocationUsageDescription</key>
  <string>LiquidOS uses location access only when a component you run asks for your current location.</string>
  <key>NSContactsUsageDescription</key>
  <string>LiquidOS uses contacts access only when a component you run asks to read or select contacts.</string>
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>LiquidOS uses calendar access only when a component you run asks to read or manage calendar events.</string>
  <key>NSCalendarsWriteOnlyAccessUsageDescription</key>
  <string>LiquidOS uses calendar write access only when a component you run asks to create calendar events.</string>
  <key>NSCalendarsUsageDescription</key>
  <string>LiquidOS uses calendar access only when a component you run asks to read or manage calendar events.</string>
  <key>NSRemindersFullAccessUsageDescription</key>
  <string>LiquidOS uses reminders access only when a component you run asks to read or manage reminders.</string>
  <key>NSRemindersUsageDescription</key>
  <string>LiquidOS uses reminders access only when a component you run asks to read or manage reminders.</string>
  <key>NSPhotoLibraryUsageDescription</key>
  <string>LiquidOS uses photo library access only when a component you run asks to read photos or videos.</string>
  <key>NSPhotoLibraryAddUsageDescription</key>
  <string>LiquidOS uses photo library add access only when a component you run asks to save photos or videos.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>LiquidOS uses speech recognition only when a component you run asks to transcribe speech.</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>LiquidOS uses automation access only when a component you run asks to control another app.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>LiquidOS uses screen recording access only when a component you run asks to view or capture the screen.</string>
  <key>NSMotionUsageDescription</key>
  <string>LiquidOS uses motion access only when a component you run asks to read motion data.</string>
  <key>NSMediaLibraryUsageDescription</key>
  <string>LiquidOS uses media library access only when a component you run asks to read music, movies, or other media.</string>
</dict>
</plist>
PLIST

xcrun swiftc \
  -target "$(uname -m)-apple-macos13.0" \
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


if [ ! -f "$PROJECT_ROOT/skills/component/SKILL.md" ]; then
  echo "Error: skills/component/SKILL.md is required." >&2
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/skills/canvas/SKILL.md" ]; then
  echo "Error: skills/canvas/SKILL.md is required." >&2
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/skills/canvas/scripts/create-instance.sh" ]; then
  echo "Error: skills/canvas/scripts/create-instance.sh is required." >&2
  exit 1
fi

mkdir -p "$RESOURCES/canvases"

# Hermes is not bundled. LiquidOS uses the user-installed `hermes` found on PATH.
if [ -f "$RESOURCES/package.json" ]; then
 npm install --prefix "$RESOURCES" --omit=dev
fi

chmod +x "$MACOS/LiquidOS"

# Ad-hoc code signature. macOS won't register an unsigned bundle with the
# notification system, so UNUserNotificationCenter.requestAuthorization fails
# silently and the app never appears in System Settings → Notifications. A
# local ad-hoc signature ("-") is enough to make notifications work.
codesign --force --deep --sign - "$APP"

if command -v otool >/dev/null 2>&1; then
  BINARY_MINOS="$(otool -l "$MACOS/LiquidOS" | awk '/LC_BUILD_VERSION/{seen=1} seen && /minos/{print $2; exit}')"
  if [ "$BINARY_MINOS" != "13.0" ]; then
    echo "Error: built binary minos is $BINARY_MINOS, expected 13.0." >&2
    echo "Check swiftc -target in mac-app/build-liquidos-app.sh." >&2
    exit 1
  fi
fi

echo "Built: $APP"
echo "Open with: open '$APP'"
