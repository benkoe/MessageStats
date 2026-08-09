# Build, signing and release — local notes

Kept out of `main` on purpose. Installs run `git pull` on `main` every launch,
and none of this belongs on a friend's machine.

**Nothing identifying goes in this file.** No Apple ID, no Team ID, no
certificate holder, no email. Those are looked up from the keychain at build
time. The app's signature necessarily publishes the team — that is unavoidable
and is the only place it should appear.

The canonical copy lives on the `docs` branch of this repo; the working copy
here is gitignored via `*.local.md` so Claude Code can read it. See
"Keeping this file" at the bottom for how to sync and restore.

`CLAUDE.md` covers the analysis side — schema traps, merging, handling the
data. This covers everything under `bin/`, plus the hard-won facts about macOS
that cost real time to learn.

---

## The three locations

```
/Applications/MessageStats.app        signed bundle — frozen, replaced only by a new DMG
  Contents/MacOS/MessageStats           compiled Swift, universal
  Contents/Resources/bootstrap.sh       sealed by the signature
  Contents/Resources/AppIcon.icns

~/Library/Application Support/MessageStats/
  app/                                  a git clone — THIS is what updates
  chat.db, names.json, ai.local.json, NOTES.local.md    the user's data
```

**The rule that governs everything: push to `main` for anything in the repo;
rebuild the DMG only when something inside the bundle changes.** The app runs
`git pull --ff-only` before starting the server, so `.mjs`, `ui/index.html` and
`launch.sh` reach every install on the next launch. The binary, `bootstrap.sh`,
`Info.plist` and the icon do not.

Data lives one level *above* the clone so `git pull` can replace the repo
wholesale without touching it. Don't ever move it back inside.

---

## Cutting a release

```
bin/sign.sh                  # → dist/MessageStats.dmg, signed + notarized + stapled
bin/sign.sh --skip-notarize  # fast check; still Gatekeepered
gh release create v1.4 dist/MessageStats.dmg --title "MessageStats 1.4" --notes "…"
```

The permanent link is `releases/latest/download/MessageStats.dmg` — it
redirects to the newest release, so anything already sent keeps working.

Bump `VERSION` in `bin/make-app.sh`. It is the single source; `sign.sh` reads it
back out of the built `Info.plist` rather than declaring its own default, which
it used to do and which silently won.

**Credentials** live in the keychain, never in a file. Look them up rather than
writing them down — this document is pushed to a public remote:

```
security find-identity -v -p codesigning     # the Developer ID and its team
xcrun notarytool history --keychain-profile "$MESSAGESTATS_NOTARY_PROFILE"
```

`sign.sh` auto-detects the identity, or takes `MESSAGESTATS_IDENTITY`. The
notary profile defaults to `MessageStats` and is overridable with
`MESSAGESTATS_NOTARY_PROFILE`. Both are checked before any build work, so a
missing one fails in seconds rather than after a compile.

The bundle identifier is in `bin/make-app.sh` (`MESSAGESTATS_BUNDLE_ID`).

### Why two notarization rounds

The app is notarized and stapled, *then* the DMG is notarized and stapled.
Stapling only the disk image leaves the app itself without a ticket once it is
dragged out — which works online and fails on a Mac that is offline the first
time it opens it.

### Why `STAGE` and `WORK` are separate in sign.sh

`STAGE` becomes the disk image verbatim. Anything written there ships. The
notary logs and the submission zip used to live in `STAGE` and got baked into
a published DMG (`notary.lVppzT`, sitting next to the app). Intermediates go in
`WORK`.

### make-app.sh's stdout is the bundle path

`sign.sh` captures it with `$(...)`. All diagnostics must go to stderr — a
single compiler warning on stdout ends up prepended to the path.

---

## macOS facts that cost time

### Quit the app before replacing it

Overwriting `/Applications/MessageStats.app` while it is running leaves macOS
holding a **stale code-signing cache keyed to that path**. Symptom: the process
starts, sits at ~32 KB RSS, spawns no children, never opens a window, writes
nothing to the log. The Dock icon bounces forever.

Diagnostic that isolates it in one step — copy the same bundle to a second path
and run both:

```
/tmp/x/MessageStats.app/Contents/MacOS/MessageStats   → ~100 MB, works
/Applications/MessageStats.app/Contents/MacOS/…       → 32 KB, dead
```

Identical bytes, so it is the path, not the build. Deleting and re-copying does
**not** reliably clear it; a reboot does. Prefer: quit, delete, install fresh.

### NSApplication.delegate is weak

```swift
static let delegate = AppDelegate()   // must outlive main()
```

Holding it in a local and writing `_ = delegate` after `run()` does not work —
that line is dead code the optimiser drops, so ARC frees the delegate right
after the assignment. The app then runs with a nil delegate:
`applicationDidFinishLaunching` never fires, no window, no server. Same 32 KB
bouncing-Dock symptom as above, which is why the two got confused once.

It survives a direct `./MessageStats` from a shell by timing luck and fails
through LaunchServices. **Always test by `open`-ing the bundle, never by
exec'ing the binary.**

### Gatekeeper is not the explanation

Developer ID + notarization + stapling means there is nothing to authorize. If
a theory requires the user to click through a security prompt, the theory is
wrong. In particular: **`CoreServicesUIAgent` always has a few 4×4 px windows
on screen.** They are not a dialog. Do not read them as one.

### App Translocation

A quarantined app launched from a path Finder did not move it to runs from
`/private/var/folders/…/AppTranslocation/…`. Dragging from the DMG to
Applications in Finder clears it. `ditto` + a manual quarantine xattr does not,
so that combination is a poor way to simulate a real install.

### `sample` lies about hardened-runtime binaries

Without `get-task-allow` it cannot read the task port, so it emits a degenerate
stack — everything collapsed to `_dyld_start` plus "Binary images description
not available". That is not evidence the process is stuck in dyld. Use RSS,
child processes, window presence and the unified log instead.

### swiftc

- Two compiles plus `lipo`; there is no multi-arch flag like clang's `-arch`.
- `-parse-as-library` is required: swiftc treats a lone input file as a script,
  and a script may not carry `@main`. SourceKit still flags `@main` in the
  editor — that diagnostic is a false positive, the build is what counts.

### App Transport Security blocks loopback http

A `WKWebView` pointed at `http://127.0.0.1` fails **silently** without
`NSAllowsLocalNetworking` in `Info.plist`.

---

## Server and UI

### The startup probe must not care what it gets

The sealed binary polls for liveness; the clone it talks to updates itself.
Requiring `200` from a named path couples the two, so a new app against an
older clone waits the full 60 s and gives up. Accept **any** HTTP reply.

Poll `/api/ping`, never `/api/status` — `status()` groups every message row by
handle (seconds on a large library) and the app polls 4×/second while waiting.
Those polls queue behind each other and slow the startup they are measuring.
The expensive half of `status()` is cached under `invalidate()`.

### Full Disk Access cannot be prompted for — the deep link is the ceiling

Every so often someone asks why the app makes people grant FDA by hand. The
answer is that **there is no request API for it.** Contacts, Calendar, Photos,
mic and camera all have `requestAccess`; `kTCCServiceSystemPolicyAllFiles` has
nothing. No entitlement, no plist key and no amount of signing makes a prompt
appear. Do not go looking again.

What *is* possible is skipping the navigation. `POST /api/open-privacy` runs
`open x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`,
which lands directly on the pane. Steps 2–4 of Option A stay, because TCC is
evaluated at process launch — the quit-and-reopen is not automatable.

Three things about that endpoint, all deliberate:

- **It goes through the server, not a link.** The UI is a `WKWebView`, which
  will not follow an `x-apple.systempreferences:` URL unless the Swift binary
  handles the navigation — and the binary is sealed, so that would mean a new
  signed and notarized DMG for a one-line feature. Through `serve.mjs` it ships
  by `git pull` like everything else.
- **It takes no URL parameter.** Any page in any browser can POST to a loopback
  server; an endpoint that opens whatever it is handed is a URL launcher for
  the whole machine. The destination is fixed in the handler and must stay
  that way.
- **The written path stays in step 1**, and a failed open points back at it, so
  the manual route survives if Apple changes the scheme.

Testing it needs care: that panel only renders when the database is *missing*
(`if(src.readable)` — the else branch), so it is invisible on any machine that
has already been set up. Run the server with a throwaway `HOME` to force
`readable:false` and `db.found:false`. This is the same invisibility that let
the `setupForm()` bug ship; see below.

### The quarantine dialog is not removable, and yours is the good one

"MessageStats is an app downloaded from the Internet" comes from the
`com.apple.quarantine` xattr the browser sets, **not** from the signature.
Notarization cannot remove it. What notarization buys is the wording: a
notarized app gets "Apple checked it for malicious software and none was
detected" plus an Open button, where an unnotarized one gets a blocking dialog
with no way through. It appears once per download, not per launch.

The only ways to avoid it are a signed and notarized `.pkg` (Installer-placed
files are not quarantined, but it needs a separate Developer ID **Installer**
certificate and replaces drag-to-Applications with an installer walkthrough) or
the Mac App Store, which is closed to this app because it reads another app's
data. Verify state with `spctl -a -vvv -t exec` — "accepted, source=Notarized
Developer ID" means there is nothing left to fix.

### Never resolve a data path from cwd in a child process

`build-names.mjs` defaulted its output to `path.resolve("names.json")` — cwd
relative — while `serve.mjs` spawned it with `cwd: HERE`, the code clone. So
"Re-import Contacts" wrote a perfectly good 303-name file into
`…/MessageStats/app/names.json` on every click, while the server read
`…/MessageStats/names.json` and reported **0 names known**. The button looked
dead and was in fact working.

Two things made it invisible. The write landed in the one directory `git pull`
replaces wholesale, so it was also the worst possible place to put user data.
And `resolveNamesPath()` probes cwd for a legacy `names.json` *before* falling
back to the data dir, so once a copy existed in the clone it kept winning.

Both halves are needed: the script goes through `resolveNamesPath()`, and the
child runs with `cwd: dataDir()` so the legacy probe can never point into code.
Any future child process that touches user data needs the same treatment —
`HERE` is where the code lives, never where the data lives.

### `cache-control: no-store` is load-bearing

With no cache headers browsers cache heuristically, so a page replaced by
`git pull` can silently keep serving the old one. The update model depends on
this header.

### serve.mjs is single-threaded

`overview()` scans every message row and blocks the event loop for ~2 s on a
700 k-message library. Everything else queues behind it. It is cached, so this
is a once-per-launch cost, but it is why the landing page can feel sticky.

### Async renders need a generation guard

Anything that awaits before touching `#main` must capture `PAGE` first and bail
if it changed — otherwise a click during the wait leaves the slow render
appended under whatever the user opened instead.

### Look for one-way doors

Three separate screens shipped as "first run only" with no way back: the setup
wizard, the AI config, and (nearly) the refresh flow. Whenever a panel renders
under `if (!configured)`, ask how someone changes it later.

`setupForm()` also had a construction-order bug worth remembering: `sync()`
ran before `box.append()` and read `key.parentElement`, which was null. It
threw, the caller's `catch` swallowed it, and the form **never rendered for
anyone** — invisible because it only appears when unconfigured, at the bottom
of a conversation report.

---

## Analysis gotchas found while building this

These belong with the schema traps in `CLAUDE.md` conceptually, but they came
out of the attachment/edit/read-receipt work:

- **`.pluginPayloadAttachment` dominates the attachment table** — 37,573 of
  them at ~150 KB in a 700 k corpus. They are link preview cards iMessage
  generates automatically, not things anyone sent. Counted as files, whoever
  pastes the most links looks like the biggest photographer. Kept out of every
  media total; see `attachmentKind()`.
- **`date_retracted` may be 0 for an entire library** while `date_edited` is
  well populated. Report the absence rather than an empty column.
- **`date_read` only exists when the reader has receipts on.** One corpus had
  27,164 samples one way and 7 the other. `MIN_READ_SAMPLE` suppresses the
  median below 20 — a median of 7 is a number, not a fact.
- **`hasColumns()` before selecting `date_edited` / `date_retracted`** — both
  are Ventura-and-later, and selecting them on an older copy kills the whole
  report.
- **Days are bucketed UTC, hour-of-day is local.** `day()` is
  `toISOString().slice(0,10)`. Pre-existing inconsistency; match it rather than
  fix it, or every historical number shifts. Using SQL `'localtime'` moved the
  busiest day's count by 213.
- **Apostrophes are stripped by the tokenizer**, so `wasn't` arrives as `wasn`.
  The contraction stumps are in the stop list; add to it rather than reworking
  the tokenizer.
- **Rolling windows, not calendar years,** for any "then vs now" comparison.
  The current year is always partial, which makes everyone look like they are
  drifting away.

---

## Keeping this file

It is gitignored, so a dead laptop loses it. The canonical copy lives on the
`docs` branch — public like everything else here, but `launch.sh` only ever
pulls `main`, and `git clone --depth 1` fetches only the default branch, so it
never reaches an install.

That is why the rule at the top exists: the branch stops it being *pulled*, not
being *found*. Anything identifying must simply not be written here.

The branch now holds more than one file — `ROADMAP.local.md` too — so both
recipes below are written to handle **every** file on it. Read the warning
after them before changing either one.

**Restore onto a new machine** — pulls back everything, not just this file:

```
git fetch origin docs
for f in $(git ls-tree -r --name-only origin/docs); do
  git show "origin/docs:$f" > "$f"
done
```

**Back up after editing** — updates the branch without touching your checkout:

```
git fetch origin docs

FILES=(CLAUDE.local.md ROADMAP.local.md)   # explicit list — never a glob, see below

(
  GIT_INDEX_FILE=$(mktemp -t docsidx); export GIT_INDEX_FILE
  git read-tree origin/docs                # start from what is already on the branch
  for f in "${FILES[@]}"; do
    git update-index --add --cacheinfo "100644,$(git hash-object -w "$f"),$f"
  done
  TREE=$(git write-tree)
  PARENT=$(git rev-parse -q --verify origin/docs)
  if [ -n "$PARENT" ]; then
    COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "Update local docs")
  else
    COMMIT=$(git commit-tree "$TREE" -m "Update local docs")
  fi
  git push origin "${COMMIT}:refs/heads/docs"
  rm -f "$GIT_INDEX_FILE"
)
```

Plumbing rather than `git checkout docs` so the working tree stays on `main` —
switching branches mid-session is how you end up committing notes to `main` by
accident. The subshell plus `GIT_INDEX_FILE` keeps all of it out of your real
index, so a half-finished backup can never turn into a staged change on `main`.

### Two ways this recipe used to bite

**It built the tree from scratch.** The original was a single `printf` piped
into `git mktree`, which produces a tree containing exactly the files you
listed — so the moment a second file existed, running it silently **deleted**
the other one from the branch. `git read-tree origin/docs` seeds the index from
what is already there, so the loop only ever adds or replaces. Nothing on the
branch can be dropped by forgetting to mention it.

**Do not turn `$FILES` into `*.local.md`.** It is tempting and it is wrong:
`NOTES.local.md` matches that glob, and it holds real names, real handles and
confirmed-identity notes. This branch is public. `NOTES.local.md` lives beside
the database in `~/Library/Application Support/`, not in the repo, and it must
stay off this branch permanently — an explicit list is what guarantees that a
stray copy in the repo root never gets published by accident.

### The shell here is zsh, and it breaks two idioms this recipe needs

Both of these fail *silently or confusingly* rather than obviously, and both
were hit while writing the version above.

- **`"$COMMIT:refs/heads/docs"` does not do what it says.** zsh reads the `:r`
  as a [history modifier](https://zsh.sourceforge.io/Doc/Release/Expansion.html)
  applied to `$COMMIT`, eats it, and pushes to `efs/heads/docs`. The error is
  `src refspec … does not match any`, which points nowhere near the cause.
  **Always brace it: `"${COMMIT}:refs/heads/docs"`.**
- **`for f in $FILES` does not split on spaces.** zsh does not word-split
  unquoted parameters, so a space-separated string arrives as one filename and
  `git hash-object` reports `could not open 'a.md b.md'`. Use a real array —
  `FILES=(…)` with `"${FILES[@]}"` — which behaves identically in bash and zsh.

The same non-splitting rule is why `${PARENT:+-p "$PARENT"}` is written out as
an `if` above: in zsh that expansion yields the single argument `-p <sha>`
rather than two, and `git commit-tree` rejects it.
