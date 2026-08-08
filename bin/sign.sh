#!/bin/bash
# Sign, notarize and package MessageStats for distribution.
#
# Produces dist/MessageStats.dmg — signed with your Developer ID, notarized by
# Apple, and stapled, so it opens with no warning on a Mac that has never seen
# it before. This is the file you send people.
#
#   bin/sign.sh                    full build (takes a few minutes; Apple's
#                                  notary service is the slow part)
#   bin/sign.sh --skip-notarize    sign only — fast, for checking the build.
#                                  The result still triggers Gatekeeper.
#
# One-time setup, before this will run:
#
#   1. A "Developer ID Application" certificate from developer.apple.com,
#      installed in your login keychain. (An "Apple Development" certificate
#      is not the same thing and cannot sign for distribution.)
#   2. Notary credentials saved to the keychain:
#        xcrun notarytool store-credentials "MessageStats" \
#          --apple-id you@example.com --team-id TEAMID --password APP-SPECIFIC
#
# Both are checked before any work starts, so a missing one fails in seconds
# rather than after a build.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${MESSAGESTATS_DIST:-$REPO/dist}"
PROFILE="${MESSAGESTATS_NOTARY_PROFILE:-MessageStats}"
VOLNAME="MessageStats"

NOTARIZE=1
[ "${1:-}" = "--skip-notarize" ] && NOTARIZE=0

die() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }
step() { printf '\n  • %s\n' "$1"; }

printf '\n  MessageStats — sign & package\n  ─────────────────────────────\n'

# ---------------------------------------------------------------- preflight

IDENTITY="${MESSAGESTATS_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null |
             grep "Developer ID Application" | head -1 |
             sed -E 's/.*"(.*)".*/\1/') || true
fi
[ -n "$IDENTITY" ] || die "No 'Developer ID Application' certificate in your keychain.
    Create one at developer.apple.com → Certificates, IDs & Profiles →
    Certificates → + → Developer ID Application, then double-click the
    downloaded .cer to install it.
    (\`security find-identity -v -p codesigning\` lists what you have.)"
echo "  ✓ $IDENTITY"

if [ "$NOTARIZE" = 1 ]; then
  xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 ||
    die "No notary credentials saved under the profile '$PROFILE'.
    Create them with:
      xcrun notarytool store-credentials \"$PROFILE\" \\
        --apple-id you@example.com --team-id TEAMID --password APP-SPECIFIC-PASSWORD
    The password is an app-specific password from appleid.apple.com, not your
    Apple ID password."
  echo "  ✓ notary profile '$PROFILE'"
fi

# Notarization staples a ticket onto the built artifacts, so everything has to
# be built fresh in a scratch directory rather than signed in place.
#
# Two directories, and the split matters: STAGE becomes the disk image verbatim,
# so nothing that isn't shipping may be written there. Intermediates — the zip
# we submit, notary logs — go in WORK. They previously lived in STAGE and got
# baked into the DMG.
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/messagestats-stage.XXXXXX")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/messagestats-work.XXXXXX")
trap 'rm -rf "$STAGE" "$WORK"' EXIT
mkdir -p "$DIST"

# ---------------------------------------------------------------- build

# make-app.sh owns the version; read it back rather than declaring a second
# default here that would silently win.
step "Building MessageStats.app…"
APP=$(bash "$REPO/bin/make-app.sh" "$STAGE")
file "$APP/Contents/MacOS/MessageStats" | grep -q "Mach-O universal" ||
  die "The bundle's executable isn't a universal binary — the Swift build failed.
    Install Xcode's Command Line Tools: xcode-select --install"
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
[ -f "$APP/Contents/Resources/AppIcon.icns" ] || echo "  note: no app icon — bin/AppIcon.icns is missing" >&2
echo "    $(basename "$APP") $VERSION"

# --options runtime is the hardened runtime, which notarization requires.
# --timestamp gets a trusted timestamp, so the signature stays valid after the
# certificate expires. No --deep: it is deprecated, and there is nothing nested
# here to sign anyway.
step "Signing…"
codesign --force --timestamp --options runtime --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP" 2>&1 | sed 's/^/    /'

# ---------------------------------------------------------------- notarize

# Apple's notary service takes zip/dmg/pkg, not a bare bundle, so the app goes
# up inside a throwaway zip. The DMG is notarized separately below.
#
# Both get stapled. Stapling only the DMG would leave the app itself without a
# ticket once it is dragged out, which works online and fails on a Mac that is
# offline the first time it opens it.
notarize() {  # path-to-submit, path-to-staple
  local submit="$1" staple="$2" log id
  log=$(mktemp "$WORK/notary.XXXXXX")
  if ! xcrun notarytool submit "$submit" --keychain-profile "$PROFILE" --wait 2>&1 |
       tee "$log" | sed 's/^/    /'; then
    id=$(grep -Eo '[0-9a-f-]{36}' "$log" | head -1 || true)
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" 2>&1 | sed 's/^/    /'
    die "Notarization failed. The log above says why."
  fi
  if ! grep -q "status: Accepted" "$log"; then
    id=$(grep -Eo '[0-9a-f-]{36}' "$log" | head -1 || true)
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" 2>&1 | sed 's/^/    /'
    die "Apple did not accept the submission. The log above says why."
  fi
  xcrun stapler staple "$staple" | sed 's/^/    /'
}

if [ "$NOTARIZE" = 1 ]; then
  step "Notarizing the app (Apple's side takes a few minutes)…"
  ditto -c -k --keepParent "$APP" "$WORK/app.zip"
  notarize "$WORK/app.zip" "$APP"
fi

# ---------------------------------------------------------------- package

# The Applications symlink is what makes the drag-to-install window work, and
# it matters more here than for most apps: Full Disk Access is tied to the
# app's identity and location, so someone who runs it straight off the mounted
# disk image grants access to something that vanishes when they eject it.
step "Building the disk image…"
ln -s /Applications "$STAGE/Applications"
DMG="$DIST/MessageStats.dmg"
rm -f "$DMG"
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" |
  sed 's/^/    /'

step "Signing the disk image…"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

if [ "$NOTARIZE" = 1 ]; then
  step "Notarizing the disk image…"
  notarize "$DMG" "$DMG"

  step "Verifying what a stranger's Mac will see…"
  xcrun stapler validate "$DMG" | sed 's/^/    /'
  spctl --assess --type open --context context:primary-signature \
        --verbose "$DMG" 2>&1 | sed 's/^/    /'
fi

printf '\n  ✓ %s (%s)\n' "$DMG" "$(du -h "$DMG" | cut -f1 | tr -d ' ')"
if [ "$NOTARIZE" = 1 ]; then
  printf '    Signed, notarized and stapled — send this file.\n\n'
else
  printf '    Signed but NOT notarized — Gatekeeper will still block it.\n\n'
fi
