#!/bin/bash
# Build MessageStats.app.
#
# The bundle is a stub. It contains no analysis code and knows no paths: at
# launch it looks for the repo in ~/Library/Application Support/MessageStats/app,
# clones it if it isn't there, and runs it. That is what makes the app
# distributable — an earlier version baked in the path of whatever machine
# built it, which is fine for a local build and useless for a signed one.
#
# Called by bin/sign.sh, which signs the result and wraps it in a DMG. That is
# the only way MessageStats is distributed: an earlier installer script built a
# second, unsigned copy on the recipient's Mac, and two bundles sharing one
# bundle identifier end up fighting over a single Full Disk Access grant.
#
# Usage: make-app.sh [destination-dir]     (default ~/Applications)

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/MessageStats.app"

# Bump when something inside the bundle changes — the binary, bootstrap.sh, the
# icon. Repo-side changes ship via git pull and don't need a new version here.
VERSION="${MESSAGESTATS_VERSION:-1.1}"
BUNDLE_ID="${MESSAGESTATS_BUNDLE_ID:-com.benkoevary.messagestats}"

mkdir -p "$DEST"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>MessageStats</string>
  <key>CFBundleDisplayName</key>       <string>MessageStats</string>
  <key>CFBundleIdentifier</key>        <string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key>           <string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleExecutable</key>        <string>MessageStats</string>
  <key>CFBundleIconFile</key>          <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>    <string>12.0</string>
  <key>NSHighResolutionCapable</key>   <true/>
  <!-- The UI is served over plain http on loopback, which App Transport
       Security blocks by default. This permits local addresses only. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key> <true/>
  </dict>
</dict>
</plist>
PLIST

# Build the main executable universal, so one signed build runs on both Apple
# Silicon and Intel. swiftc takes one -target at a time, unlike clang's -arch,
# so this is two compiles and a lipo.
#
# -parse-as-library because swiftc treats a lone input file as a script, and a
# script may not carry @main.
# Diagnostics go to stderr, never stdout: this script's stdout is the bundle
# path and nothing else, because sign.sh captures it with $(...). A single
# compiler warning on stdout would end up prepended to the path.
build_swift() {
  local target="$1" out="$2"
  swiftc -parse-as-library -O -target "$target" \
         -o "$out" "$REPO/bin/MessageStats.swift" >&2
}

EXE="$APP/Contents/MacOS/MessageStats"
BUILT=0
if command -v swiftc >/dev/null 2>&1; then
  SLICES=$(mktemp -d "${TMPDIR:-/tmp}/messagestats-swift.XXXXXX")
  if build_swift arm64-apple-macos12.0 "$SLICES/arm64" &&
     build_swift x86_64-apple-macos12.0 "$SLICES/x86_64"; then
    lipo -create -output "$EXE" "$SLICES/arm64" "$SLICES/x86_64" && BUILT=1
  elif [ -f "$SLICES/arm64" ]; then
    # Cross-compiling to Intel needs the x86_64 SDK slice, which a
    # Command-Line-Tools-only machine may not have. Ship what we can.
    echo "  note: Intel slice unavailable — building arm64-only" >&2
    cp "$SLICES/arm64" "$EXE" && BUILT=1
  fi
  rm -rf "$SLICES"
fi

# No swiftc means no window: fall back to the old behaviour, a bundle that
# starts the server and opens the UI in the default browser. It works, it just
# has no Dock icon and no ⌘Q — and it cannot be signed or notarized, since the
# hardened runtime is a flag on a Mach-O binary and this is a script.
if [ "$BUILT" = 0 ]; then
  echo "  note: swiftc unavailable — building the browser-based fallback bundle" >&2
  cat > "$EXE" <<'LAUNCH'
#!/bin/bash
exec /bin/bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../Resources" && pwd)/bootstrap.sh"
LAUNCH
fi
chmod +x "$EXE"

cp "$REPO/bin/bootstrap.sh" "$APP/Contents/Resources/bootstrap.sh"
chmod +x "$APP/Contents/Resources/bootstrap.sh"

# Optional — drop an .icns here and it gets picked up. Without one macOS shows
# the blank generic-application icon.
[ -f "$REPO/bin/AppIcon.icns" ] && cp "$REPO/bin/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# Locally-built bundles aren't quarantined, but strip it if it ever is.
xattr -cr "$APP" 2>/dev/null || true

echo "$APP"
