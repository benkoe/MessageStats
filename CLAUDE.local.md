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

**Restore onto a new machine:**

```
git fetch origin docs
git show origin/docs:CLAUDE.local.md > CLAUDE.local.md
```

**Back up after editing** — updates the branch without touching your checkout:

```
BLOB=$(git hash-object -w CLAUDE.local.md)
TREE=$(printf '100644 blob %s\tCLAUDE.local.md\n' "$BLOB" | git mktree)
PARENT=$(git rev-parse -q --verify origin/docs)
COMMIT=$(git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "Update build notes")
git push origin "$COMMIT:refs/heads/docs"
```

Plumbing rather than `git checkout docs` so the working tree stays on `main` —
switching branches mid-session is how you end up committing notes to `main` by
accident.
