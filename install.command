#!/bin/bash
# MessageStats — one-file installer.
#
# This is the file you send someone. Double-click it: it checks for Node and
# git, downloads MessageStats, builds a double-clickable app, and opens it.
# No terminal commands to type.

set -uo pipefail
REPO_URL="${MESSAGESTATS_REPO:-https://github.com/benkoe/MessageStats.git}"
DEST="$HOME/Applications/MessageStats"

printf '\n  MessageStats installer\n  ──────────────────────\n\n'

# Finder-launched scripts don't inherit a login shell PATH.
find_bin() {
  local name="$1"
  command -v "$name" 2>/dev/null && return 0
  for p in /opt/homebrew/bin /usr/local/bin /usr/bin "$HOME/.volta/bin" "$HOME/.local/bin"; do
    [ -x "$p/$name" ] && { echo "$p/$name"; return 0; }
  done
  local nvm
  nvm=$(ls -d "$HOME/.nvm/versions/node"/*/bin/"$name" 2>/dev/null | sort -V | tail -1)
  [ -n "$nvm" ] && { echo "$nvm"; return 0; }
  return 1
}
offer() {  # title, message, button, url
  local r
  r=$(osascript -e "display dialog \"$2\" with title \"$1\" buttons {\"Cancel\", \"$3\"} default button \"$3\"" 2>/dev/null)
  [[ "$r" == *"$3"* ]] && open "$4"
}

NODE=$(find_bin node) || {
  echo "  ✗ Node.js is not installed."
  offer "MessageStats" \
    "MessageStats needs Node.js.\n\nIt is a free one-time install. Download the macOS installer, run it, then double-click this installer again." \
    "Get Node.js" "https://nodejs.org/en/download"
  echo "  Install Node.js, then run this again."; echo; read -r -p "  Press return to close." _; exit 1
}
MAJOR=$("$NODE" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)
if [ "$MAJOR" -lt 24 ]; then
  echo "  ✗ Node.js $("$NODE" -v) is too old — MessageStats needs 24 or newer."
  offer "MessageStats" "MessageStats needs Node.js 24 or newer. You have $("$NODE" -v)." "Get Node.js" "https://nodejs.org/en/download"
  echo; read -r -p "  Press return to close." _; exit 1
fi
echo "  ✓ Node.js $("$NODE" -v)"

GIT=$(find_bin git) || {
  echo "  ✗ git is not installed."
  echo "    macOS ships it with the Command Line Tools — a dialog should appear now."
  xcode-select --install 2>/dev/null
  offer "MessageStats" "MessageStats needs git.\n\nAccept the 'Install Command Line Tools' dialog that just appeared, wait for it to finish, then double-click this installer again." "OK" ""
  echo; read -r -p "  Press return to close." _; exit 1
}
echo "  ✓ git"

mkdir -p "$HOME/Applications"
if [ -d "$DEST/.git" ]; then
  echo "  • Already installed — updating…"
  "$GIT" -C "$DEST" pull --ff-only --quiet || echo "    (couldn't fast-forward; leaving as-is)"
else
  echo "  • Downloading to $DEST…"
  if ! "$GIT" clone --quiet --depth 1 "$REPO_URL" "$DEST"; then
    echo "  ✗ Download failed. Check your connection, or that $REPO_URL is reachable."
    echo; read -r -p "  Press return to close." _; exit 1
  fi
fi
echo "  ✓ Installed"

chmod +x "$DEST/bin/"*.sh 2>/dev/null
APP=$(bash "$DEST/bin/make-app.sh" "$HOME/Applications")
echo "  ✓ Created $APP"

cat <<TXT

  Done. MessageStats is in your Applications folder.

  One more step, when you're ready to load your messages:
    System Settings → Privacy & Security → Full Disk Access
    → turn on MessageStats

  That lets it copy your message database. It only ever reads a copy,
  and nothing leaves your Mac.

  Opening it now…

TXT
open "$APP"
sleep 2
