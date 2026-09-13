#!/bin/zsh
set -euo pipefail

MAC_ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$MAC_ROOT/.." && pwd)"
APP="$MAC_ROOT/build/LiquidOS.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
ICONSET="$MAC_ROOT/LiquidOS.iconset"

# Which architectures to build. Defaults to this machine's, so a local build
# stays as fast as it ever was; pass "x86_64", "arm64", or "universal" to pick.
# Each arch carries its own ~140MB Node runtime, so a universal bundle is
# roughly double the download and half of it is dead weight on any given Mac —
# shipping one bundle per arch is usually the better trade.
case "${1:-$(uname -m)}" in
  universal) ARCHS=(arm64 x86_64) ;;
  arm64)     ARCHS=(arm64) ;;
  x86_64)    ARCHS=(x86_64) ;;
  *) echo "Error: unknown architecture '${1}' (want arm64, x86_64, or universal)." >&2; exit 1 ;;
esac
goarch_for() { [ "$1" = "arm64" ] && echo arm64 || echo amd64; }
nodearch_for() { [ "$1" = "arm64" ] && echo darwin-arm64 || echo darwin-x64; }
echo "Building for: ${ARCHS[*]}"

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

# swiftc emits one architecture at a time, so build a slice per arch and fuse
# them only when there's more than one. Every slice carries the macos13.0 floor
# the check at the end asserts.
SLICE_DIR="$(mktemp -d)"
for ARCH in "${ARCHS[@]}"; do
  xcrun swiftc \
    -target "${ARCH}-apple-macos13.0" \
    "$MAC_ROOT/LiquidOSApp.swift" \
    -o "$SLICE_DIR/LiquidOS-$ARCH" \
    -framework Cocoa \
    -framework WebKit \
    || { echo "Error: swiftc failed for $ARCH." >&2; exit 1; }
done
lipo -create "$SLICE_DIR"/LiquidOS-* -output "$MACOS/LiquidOS" \
  || { echo "Error: lipo failed for the app binary." >&2; exit 1; }
rm -rf "$SLICE_DIR"

if [ -d "$ICONSET" ]; then
  iconutil -c icns "$ICONSET" -o "$RESOURCES/LiquidOS.icns"
else
  echo "Warning: $ICONSET missing; building without custom icon."
fi

# Prepare the client assets the server binary embeds.
( cd "$PROJECT_ROOT" && node scripts/build-client.mjs >/dev/null ) \
  || { echo "Error: client build failed." >&2; exit 1; }

# Build the Go server binary. -trimpath rewrites build-machine paths to the
# module path, -s -w drops the symbol table and DWARF, -buildvcs=false keeps the
# git revision out — standard release flags, and a smaller binary.
( cd "$PROJECT_ROOT/go-server" \
    && for ARCH in "${ARCHS[@]}"; do \
         CGO_ENABLED=0 GOOS=darwin GOARCH="$(goarch_for "$ARCH")" \
           go build -trimpath -buildvcs=false -ldflags="-s -w" -o "liquidos-server-$ARCH" . || exit 1; \
       done \
    && rm -f liquidos-server \
    && lipo -create liquidos-server-* -output liquidos-server \
    && rm -f liquidos-server-arm64 liquidos-server-x86_64 ) \
  || { echo "Error: go build (go-server) failed." >&2; exit 1; }

# What the app needs at runtime, named one by one. This is an allowlist: a new
# folder in the repo stays out of the bundle until it is listed here.
BUNDLED_PATHS=(
  agent
  diagnostics
  skills
  scripts/keyboard-seed
  package.json
)

for rel in "${BUNDLED_PATHS[@]}"; do
  if [ ! -e "$PROJECT_ROOT/$rel" ]; then
    echo "Error: $rel is required in the bundle but missing from the source tree." >&2
    exit 1
  fi
  mkdir -p "$RESOURCES/$(dirname "$rel")"
  rsync -a --exclude '.DS_Store' --exclude '__MACOSX' \
    "$PROJECT_ROOT/$rel" "$RESOURCES/$(dirname "$rel")/"
done

# Only this arch's server binary; the Linux cross-builds sit beside it in the
# source tree and have no business in a Mac bundle.
mkdir -p "$RESOURCES/go-server"
rsync -a "$PROJECT_ROOT/go-server/liquidos-server" "$RESOURCES/go-server/"


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

# Hermes is not bundled. LiquidOS uses the user-installed `hermes` found on PATH.
# The lockfile pins this install, then goes away — nothing reads it at runtime.
cp "$PROJECT_ROOT/package-lock.json" "$RESOURCES/package-lock.json"
npm install --prefix "$RESOURCES" --omit=dev
rm -f "$RESOURCES/package-lock.json"

# Bundle a self-contained Node runtime so the app runs with no user-installed
# node. The Homebrew node links Homebrew dylibs (openssl, icu4c, libnode…) and
# isn't portable, so fetch the official build — one binary linking only system
# libraries — for this arch, matching the version we test against. Cached.
# Node ships one binary per architecture, so fetch both and fuse them into a
# universal node — otherwise the app is universal everywhere except the runtime
# it shells out to.
NODE_VERSION="$(node -p 'process.version')"
NODE_CACHE="$MAC_ROOT/.node-cache"
mkdir -p "$NODE_CACHE"
mkdir -p "$RESOURCES/runtime/bin"
NODE_SLICES=()
for ARCH in "${ARCHS[@]}"; do
  NODE_ARCH="$(nodearch_for "$ARCH")"
  NODE_PKG="node-${NODE_VERSION}-${NODE_ARCH}"
  NODE_TARBALL="$NODE_CACHE/${NODE_PKG}.tar.gz"
  if [ ! -f "$NODE_TARBALL" ]; then
    echo "Downloading ${NODE_PKG}…"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_PKG}.tar.gz" -o "$NODE_TARBALL" \
      || { echo "Error: could not download Node ${NODE_VERSION} (${NODE_ARCH})." >&2; exit 1; }
  fi
  rm -rf "$NODE_CACHE/${NODE_PKG}"
  tar -xzf "$NODE_TARBALL" -C "$NODE_CACHE"
  NODE_SLICES+=("$NODE_CACHE/${NODE_PKG}/bin/node")
done
lipo -create "${NODE_SLICES[@]}" -output "$RESOURCES/runtime/bin/node" \
  || { echo "Error: lipo failed for the bundled node." >&2; exit 1; }
chmod +x "$RESOURCES/runtime/bin/node"

# Guard against ever shipping a non-portable node: it must link only system
# libraries (/usr/lib, /System) and its own @rpath/@executable_path.
# Read only the indented dependency lines: otool -L prints an unindented
# "<path> (architecture <arch>):" header for EACH slice of a fat binary, and
# skipping just the first line would treat the second header as a dependency.
if otool -L "$RESOURCES/runtime/bin/node" | awk '/^\t/{print $1}' \
    | grep -qvE '^/usr/lib/|^/System/|^@rpath/|^@executable_path/'; then
  echo "Error: bundled node has non-system dylib dependencies (not portable):" >&2
  otool -L "$RESOURCES/runtime/bin/node" >&2
  exit 1
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
