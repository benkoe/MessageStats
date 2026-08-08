#!/bin/bash
# Build MessageStats.app — a double-clickable wrapper around bin/launch.sh.
#
# A .app bundle is just a directory with a plist and an executable, so this
# needs no tooling. Regenerating it is safe and idempotent.
#
# Why bother instead of shipping a .command file: macOS grants Full Disk Access
# per application, so "drag MessageStats into Full Disk Access" is a normal
# thing to ask someone — and far better than telling them to grant it to
# Terminal, which would give it to everything they ever run.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/MessageStats.app"

mkdir -p "$APP/Contents/MacOS"
rm -rf "$APP/Contents/Resources"; mkdir -p "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>MessageStats</string>
  <key>CFBundleDisplayName</key>       <string>MessageStats</string>
  <key>CFBundleIdentifier</key>        <string>local.messagestats.app</string>
  <key>CFBundleVersion</key>           <string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleExecutable</key>        <string>MessageStats</string>
  <key>LSMinimumSystemVersion</key>    <string>12.0</string>
  <!-- Terminal window stays visible so the user can read progress and stop it. -->
  <key>LSBackgroundOnly</key>          <false/>
</dict>
</plist>
PLIST

# The bundle stores only the repo path; all real logic lives in launch.sh, so
# `git pull` updates the app's behaviour without rebuilding the bundle.
cat > "$APP/Contents/MacOS/MessageStats" <<LAUNCH
#!/bin/bash
exec "$REPO/bin/launch.sh"
LAUNCH

chmod +x "$APP/Contents/MacOS/MessageStats"
# Locally-built bundles aren't quarantined, but strip it if it ever is.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "$APP"
