#!/bin/bash
# Sealed inside MessageStats.app, run by the bundle's main executable.
#
# Keep this file boring and small. It is covered by the app's code signature,
# which means it is the one piece of MessageStats that `git pull` cannot
# update — changing it requires re-signing, re-notarizing and asking everyone
# to download the app again. So it does the minimum: make sure the code is on
# disk, then hand off to launch.sh, which lives in the repo and does update.
#
# It duplicates a little of launch.sh (find_bin, dialog) on purpose. launch.sh
# has to keep working when run directly from a terminal, and this has to work
# before the repo exists, so neither can import from the other.

set -uo pipefail

REPO_URL="${MESSAGESTATS_REPO:-https://github.com/benkoe/MessageStats.git}"
CODE="${MESSAGESTATS_CODE:-$HOME/Library/Application Support/MessageStats/app}"

# A .app launched from Finder does not inherit your shell PATH, so `git` is
# usually not findable even when it is installed. Look where it actually lives.
find_bin() {
  local name="$1"
  command -v "$name" 2>/dev/null && return 0
  for p in /opt/homebrew/bin /usr/local/bin /usr/bin "$HOME/.volta/bin" "$HOME/.local/bin"; do
    [ -x "$p/$name" ] && { echo "$p/$name"; return 0; }
  done
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

GIT=$(find_bin git) || {
  # git ships with the Command Line Tools; this triggers Apple's own installer.
  xcode-select --install 2>/dev/null
  dialog "MessageStats" \
    "MessageStats needs git, which comes with Apple's Command Line Tools.\n\nAccept the install dialog that just appeared, wait for it to finish, then open MessageStats again."
  exit 1
}

if [ ! -d "$CODE/.git" ]; then
  mkdir -p "$(dirname "$CODE")"
  rm -rf "$CODE"   # a partial clone from an interrupted first run
  if ! "$GIT" clone --quiet --depth 1 "$REPO_URL" "$CODE"; then
    dialog "MessageStats" \
      "MessageStats couldn't download its code from GitHub.\n\nCheck your internet connection and open it again."
    exit 1
  fi
  # Pull-only, belt and braces. GitHub already refuses pushes from anyone who
  # is not a collaborator; this makes it impossible from here even by accident.
  "$GIT" -C "$CODE" remote set-url --push origin DISABLED-pull-only 2>/dev/null
  "$GIT" -C "$CODE" config --local push.default nothing 2>/dev/null
fi

if [ ! -x "$CODE/bin/launch.sh" ]; then
  chmod +x "$CODE/bin/"*.sh 2>/dev/null
fi

[ -f "$CODE/bin/launch.sh" ] || {
  dialog "MessageStats" \
    "MessageStats's code is missing or damaged.\n\nDelete this folder and open MessageStats again to reinstall it:\n$CODE"
  exit 1
}

exec /bin/bash "$CODE/bin/launch.sh"
