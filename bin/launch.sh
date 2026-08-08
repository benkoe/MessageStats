#!/bin/bash
# MessageStats launcher. Run by MessageStats.app; also fine to run directly.
#
# Updates happen HERE, before the server starts — pulling while node is running
# would mean reloading code mid-flight. By the time the server boots it is
# already the new version, so there is nothing to restart.

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

# A .app launched from Finder does NOT inherit your shell PATH, so `node` is
# usually not findable even when it is installed. Look where it actually lives.
find_bin() {
  local name="$1"
  command -v "$name" 2>/dev/null && return 0
  for p in /opt/homebrew/bin /usr/local/bin /usr/bin \
           "$HOME/.volta/bin" "$HOME/.local/bin" "$HOME/n/bin"; do
    [ -x "$p/$name" ] && { echo "$p/$name"; return 0; }
  done
  # nvm keeps versions in a directory tree with no stable path — take the newest.
  local nvm
  nvm=$(ls -d "$HOME/.nvm/versions/node"/*/bin/"$name" 2>/dev/null | sort -V | tail -1)
  [ -n "$nvm" ] && { echo "$nvm"; return 0; }
  return 1
}

dialog() {  # title, message, [button that opens a URL], [url]
  if [ -n "${3:-}" ]; then
    local r
    r=$(osascript -e "display dialog \"$2\" with title \"$1\" buttons {\"Cancel\", \"$3\"} default button \"$3\"" 2>/dev/null)
    [[ "$r" == *"$3"* ]] && open "$4"
  else
    osascript -e "display dialog \"$2\" with title \"$1\" buttons {\"OK\"} default button \"OK\"" >/dev/null 2>&1
  fi
}

NODE=$(find_bin node) || {
  dialog "MessageStats" \
    "MessageStats needs Node.js to run.\n\nIt is a free one-time install from nodejs.org. Get the macOS installer, run it, then open MessageStats again." \
    "Get Node.js" "https://nodejs.org/en/download"
  exit 1
}

# node:sqlite is only stable from Node 24.
MAJOR=$("$NODE" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)
if [ "$MAJOR" -lt 24 ]; then
  dialog "MessageStats" \
    "MessageStats needs Node.js 24 or newer. You have $("$NODE" -v).\n\nInstall the current version from nodejs.org and open MessageStats again." \
    "Get Node.js" "https://nodejs.org/en/download"
  exit 1
fi

# Update before starting. Read-only by construction: this only ever runs fetch
# and pull --ff-only. It never pushes, never commits, never rewrites history.
# --ff-only so a local edit is reported rather than clobbered.
GIT=$(find_bin git) || GIT=""
if [ -n "$GIT" ] && [ -d "$REPO/.git" ]; then
  echo "Checking for updates…"
  if "$GIT" -C "$REPO" fetch --quiet origin 2>/dev/null; then
    BEHIND=$("$GIT" -C "$REPO" rev-list --count HEAD..@{u} 2>/dev/null || echo 0)
    if [ "${BEHIND:-0}" -gt 0 ]; then
      if "$GIT" -C "$REPO" pull --ff-only --quiet 2>/dev/null; then
        echo "Updated ($BEHIND new commit(s))."
      else
        echo "An update is available but couldn't be applied automatically."
        echo "You have local changes — run 'git status' in $REPO."
      fi
    fi
  fi
fi

PORT="${MESSAGESTATS_PORT:-4173}"
# If it's already running, just focus the tab rather than failing to bind.
if curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/status" 2>/dev/null; then
  open "http://127.0.0.1:$PORT/"
  echo "MessageStats was already running — opened it in your browser."
  exit 0
fi

echo "Starting MessageStats…"
"$NODE" "$REPO/serve.mjs" --port "$PORT" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM

for _ in $(seq 1 40); do
  curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/status" 2>/dev/null && break
  sleep 0.25
done
open "http://127.0.0.1:$PORT/"

echo ""
echo "  MessageStats is running at http://127.0.0.1:$PORT"
echo "  Close this window (or press Ctrl-C) to stop it."
echo ""
wait $SERVER
