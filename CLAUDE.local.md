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

### bplist.mjs, and why it has its own checker

`bin/check-bplist.mjs` decodes real blobs with both `bplist.mjs` and `plutil`
and compares. Run it after touching the parser — 1,600 blobs, expect 0
failures. It exists because a hand-written binary parser that is *nearly* right
produces plausible text rather than an error, which is the same reason
`README.md` describes validating the `streamtyped` parser against ground truth.

It earned itself immediately by catching a bug worth remembering:
**`Buffer.subarray()` returns a view onto the same memory, and `.swap16()`
mutates in place.** Decoding a UTF-16 string therefore corrupted the blob being
parsed — every later read came back byte-swapped, and the caller's buffer was
damaged too. `Buffer.from(...)` before swapping.

Fuzzing it found what the ground-truth check could not: **trust nothing in the
trailer.** A corrupted blob claiming 10^12 objects made `new Array(numObjects)`
OOM the whole server process, and container lengths have the same exposure —
every count from the bytes must be validated against the bytes that exist
before it is believed. The fuzz harness (truncations, byte flips, hostile
trailers, run under `--max-old-space-size=256`) is worth re-running after any
parser change alongside the plutil check.

It also settled a claim that had been asserted in a comment: **`plutil -p`
output is not machine-readable.** It does not escape embedded double quotes, so
a message containing `"buying"` splits into fragments under any regex, and an
unescaped quote lets a greedy match run past the line end and swallow plutil's
own layout. The checker compares by *containment*, single-line, for that
reason — and it is why the parser reads bytes rather than scraping that output.

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

### Setting `location.hash` *and* rendering renders twice

`#setbtn` used to do `location.hash="settings"; renderSettings();`. Assigning
the hash fires `hashchange`, whose listener also calls `renderSettings()` — so
two renders raced, each cleared `#main` before its own `await`, and each then
appended a full set of cards. The Settings page came out **doubled**.

It looked like an assistant bug because it appeared to fix itself once a key
was saved: saving reloads the page, and on reload the hash is *already*
`#settings`, so assigning it again fires no event and only one render runs.

Two fixes, both worth keeping. `renderSettings()` now takes `gen=newPage()` and
returns if `gen!==PAGE` after its await — the same generation guard the rest of
the async renders use. And the click handler only renders directly when the
hash is already `#settings`; otherwise it sets the hash and lets `hashchange`
do it. Either alone would have worked; the guard is the one that generalises.

### Naming and merging are UI now — the warnings had no buttons

Two banners told people to go and edit files: "Add them to names.json by hand"
and "Open one and press Merge". The first asked for a text editor; the second
pointed at a button that worked but **forgot** — merging was a per-view toggle,
so the same decision had to be remade every time the conversation was opened,
and a report read without it is silently missing history.

**Names.** `POST /api/names` takes either `{handle, name}` or
`{handle, aliasOf}`, and Settings offers both on every unnamed number: a text
field, and a picker of everyone already known. The two are not interchangeable
— `name` invents a person, `aliasOf` folds the handle into an existing one —
and choosing wrong is exactly the split-identity trap in `CLAUDE.md`, one
person counted twice with half their history each. The UI says so above the
list rather than leaving it to be discovered.

The writer tolerates both shapes `loadIdentities()` accepts (`{names,aliases}`
and a bare handle→name map), normalises the handle, and clears the opposite
entry so naming undoes an alias and vice versa. It rewrites the whole file:
a few hundred hand-edited entries, where preserving shape beats write speed.

**Merges.** `merges.local.json` in the data directory, chat id → `{merge, ids}`,
gitignored. Deliberately *not* in `names.json`: that file is identities and is
hand-edited; this is a machine-written record of decisions about threads. The
banner now offers "Merge them" and "Merge them — and remember", plus "Forget
this" once a decision exists. `openChat()` prefers an explicit click, then the
remembered decision, then the global `autoMerge` preference — and `loadMerges()`
must resolve **before** `boot()`, or the first conversation of a session
ignores every decision.

### The reaction breakdown is a matrix, not a stacked bar

The kinds used to print as a sentence — "loved 9,633 · laughed at 6,689 · …" —
which you read rather than see, and which said nothing about *who* does what.
It is now a column per reaction inside the given/got table, headed by the glyph
iMessage shows (`TAPBACK_ICONS`, beside the names in `analyze.mjs` so the CLI
prints the same thing).

Deliberately **not** a stacked bar: eight categories in one bar is unreadable,
and it would need eight new colours nothing else in the app uses. The glyph
carries identity, so no colour is invented; the only colour is a single-hue
cell tint standing for "share of this person's own biggest reaction", which is
what makes the dominant one findable by eye. Tint is normalised **per row** —
hearts and stickers differ seven-hundred-fold, so a global scale would leave
every column but one blank. A spelled-out legend sits underneath: identity is
never glyph-alone.

### Tone presets have to differ in *kind*, not degree

"Silly" and "Funny" both meant "make jokes" and nobody could tell them apart —
a fair question to be asked. A preset earns its slot only if it changes the
*format* of the answer, not its volume. "Funny" is now explicitly ordinary
prose with a joke per finding; "Unhinged" replaces "Silly" and commits to a
stated frame — nature documentary, court transcript, epic poem — for the whole
answer. If two presets can't be told apart from their output, delete one.

### The assistant: tone presets, and never present a cut-off answer as whole

`TONES` in `serve.mjs` appends a tone instruction to `AI_SYSTEM`. The grounding
rules stay in front of every preset, so no tone can license inventing a figure
to land a joke — "roast them" still has to roast them with real numbers.

`ask()` in `llm.mjs` returns `{ text, truncated }` rather than a bare string.
An answer that stopped at the token ceiling is indistinguishable from a
finished one — it simply ends mid-sentence — and one did: a question asking for
a line per person in a large group ran past 4,096 tokens and stopped mid-word,
with nothing anywhere saying so. Each provider reports it differently
(`finish_reason:"length"`, `stop_reason:"max_tokens"`, `finishReason:"MAX_TOKENS"`),
so each wire has its own `truncated` probe. The ceiling is now 16,384, but the
flag matters more than the number: a truncated answer costs the same as a
complete one and is worth nothing, so it must be visible.

Export builds the Markdown in the page and downloads a Blob — the server never
sees it, which keeps the local-only promise true for exports too.

### WKWebView cannot download anything — the Export button did nothing

A Blob plus `<a download>` is the standard way to save a file from a page. It
works in a browser and is **silently ignored** in the app: `WKWebView` drops
downloads unless the host implements `WKDownloadDelegate`, and
`MessageStats.swift` does not. No error, no console message, no file — the
button simply did nothing, and it tested fine in Chrome.

This is the same shape as the Full Disk Access deep link above, and the same
answer applies: anything needing the sealed binary means a new signed DMG, so
route it through the server instead. `POST /api/export` writes the file to
`~/Downloads` and runs `open -R` to reveal it in Finder. Not a save dialog —
that would need `NSSavePanel` in the binary — but the same outcome, and it
ships by `git pull`.

**The endpoint names the file, not the caller.** It writes to disk and any page
in any browser can POST to a loopback server, so the name is stripped to a
basename, non-filename characters removed, leading dots dropped so it cannot
create a hidden file, and `.md` is always appended. Verified: a name of
`../../../../tmp/evil` lands as a literal file inside `~/Downloads`, not in
`/tmp`.

Anything that reads well pasted elsewhere should also offer **Copy** —
clipboard access works from `http://127.0.0.1` because localhost counts as a
secure context, with the `execCommand` selection trick as a fallback.

### An in-flight ask must not live in the DOM

Clicking another conversation calls `openChat()`, which empties `#main`. There
is no `AbortController` anywhere in the UI, so the request was never cancelled
— it completed, was **billed**, and rendered into a detached node nobody could
see. Worst of both worlds: you paid and waited and got nothing.

`ASKS` (a module-level `Map` keyed by chat id) holds the promise and settles
the result into the entry, so it outlives any panel. A rebuilt `askPanel()`
adopts the existing entry rather than firing a second request, and a chat with
one in the air gets a pulsing dot in the sidebar. Anything else expensive and
async should be held the same way — the generation guard is right for cheap
renders, but discarding an answer somebody is paying for is not.

**Disabling the button is not enough.** Enter in the question field and the
suggestion chips both call `run()` directly, so the guard has to be the first
line of `run()` itself — `if(live && !live.done) return` against the `ASKS`
entry — with the disabled button and dimmed chips as the visible half. A
second ask is *charged for*, not merely wasted, and without the guard three
impatient clicks sent three requests. Verified by counting requests at the stub:
three clicks, one request.

A long ask also has to look alive. A line of muted text reads as a hung app
after twenty seconds; the panel shows a spinner and a seconds counter that
ticks, plus a note that you can leave the page.

Testing this needs a slow provider you are not paying for. Point a throwaway
`MESSAGESTATS_DATA` at a directory whose `ai.local.json` uses the `ollama`
provider with `baseUrl` set to a local stub that sleeps before replying — the
OpenAI wire is simple enough to fake in a dozen lines, and symlinking `chat.db`
in keeps it reading real data without touching the real config.

### Saved answers live beside the database, not in the browser

`ai-history.local.json` in the data directory, capped at 200, gitignored. It
quotes real conversations, so it belongs with the other private files where it
can be read and deleted by hand rather than in an opaque browser store that a
"clear site data" would silently take with it.

### Export is plain text, deliberately

One format, `.txt`, no picker. An RTF writer was built and validated and then
removed as a choice nobody needed — it is in git history at `aa389f6` if it
ever comes back. Two things bit while writing it, worth knowing before anyone
tries again: escape `\`, `{` and `}` **before** inserting control words, or the
backslashes you just added get escaped in turn; and `\uN` is a **signed 16-bit**
value, so anything above 32767 must be written as `N - 65536`. Every emoji is a
surrogate pair above that line. `textutil -convert txt -stdout file.rtf` parses
exactly like TextEdit and is the way to check.

In the plain-text converter, strip list markers with `[ \t]*`, never `\s*` —
`\s` matches newlines, so the blank line before a list gets eaten and
paragraphs run into the bullets.

### Report paths, never hardcode them

The Settings and About cards printed `~/Library/Application Support/MessageStats`
as a literal string, which is a lie whenever `MESSAGESTATS_DATA` is set — the
screen names one directory while the app reads another. `status()` returns
`dirs.data` and `dirs.code` and the page prints those.

### Assistant answers are Markdown — render them

Models emit `**bold**` whether or not the prompt asks for it. The answer was
being inserted as plain text in a `white-space:pre-wrap` div, so every name in
an answer showed up wrapped in literal asterisks.

`markdown()` in `ui/index.html` handles headings, bullet and numbered lists,
bold, italic and backtick code. It builds **DOM nodes, never innerHTML** — the
text comes from a model, and `el()` routes every string through
`createTextNode`, so there is no path from model output to markup. Keep it that
way if the renderer grows.

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
- **App bubbles are sessions, not rows — and `REAL_MESSAGE_WHERE` is wrong in
  both directions for them.** Every poll vote and game move writes another row
  with the same `balloon_bundle_id` (`associated_message_type` 2/3/4000),
  chained to the balloon it updates via `associated_message_guid`, and chains
  are transitive. Counting rows reported one poll as "Polls 5"; filtering to
  `associated_message_type = 0` dropped polls whose *every* row is an update
  type. Count chain roots. Also: third-party bundle ids end in a generic
  segment (`.MessagesExtension`, `.ext`), so "last dotted component" collapsed
  every third-party app into the same name — and 211 raw rows in one chat were
  41 actual polls.
- **`is_played` only exists on received audio.** Your own sends never get a
  local played mark, so "10 sent, 3 played" implied seven ignored voice notes
  when every receivable one was played. Split by direction; report played
  against received only.
- **Whatever a report card shows, `brief()` must carry.** The assistant answers
  from `brief()`'s serialization, not from the page — a whole roadmap of new
  sections (reply graph, group history, links, services, apps, audio, custom
  emoji) shipped to both frontends and none of it reached the assistant, which
  then answered questions about numbers on the very page the user was reading
  from a context that lacked them. When adding a section, teach `brief()` in
  the same commit.
- **`other_handle` is a handle ROWID, not a handle string.** It names the
  person a group event acted on, and joining it against `handle.id` as text
  returns nothing at all — which reads as "the column is empty" and is the
  reason group membership looked unrecoverable. `CAST(m.other_handle AS INTEGER)`
  joined to `handle.ROWID` resolves it. Confirmed semantics: `item_type` 2 is a
  rename (new name in `group_title`), 1 is a roster change with
  `group_action_type` 0 = added and 1 = removed, 3 is the sender leaving.
  Types 4, 5 and 6 exist and remain unidentified.
- **Two reply metrics, kept apart on purpose.** Adjacency ("whoever spoke next
  was answering") covers every message and is a guess; `thread_originator_guid`
  covers 2–9% of a conversation and is a fact. Blending them would make both
  untrustworthy, so they are separate sections with the inferred one saying so
  in its title. They shipped with nearly identical names at first — "Who
  answers whom fastest" beside "Who answers whom" — which is worse than having
  only one; if two sections measure the same thing differently, the difference
  belongs in the heading.
- **Group events are often recorded twice**, so collapse by (day, kind, target)
  before displaying — otherwise one person leaving reads as two departures. And
  an add plus a remove of the *same* person on the same day is normally a
  handle switch (new SIM, iCloud address) that the alias map has folded under
  one name, not somebody being thrown out and readmitted.
- **A tapback targets a message *part*, not a message.** The part is a prefix
  on `associated_message_guid` — `p:3/<guid>` — and a photo dump is one message
  with many parts. One person hearting fifteen of eighteen photos produced
  "15×" on a single message in a **two-person** chat, which reads as a data
  bug and is not one. Count **distinct reactors per message**, so the ceiling
  is the roster; the raw row count is a photo count wearing a reaction's
  clothes. Two consequences: the most-reacted ranking is worth nothing in a
  1:1 chat (max 2, usually 1) and is left out there, and those messages have no
  text — they rendered as blank rows until they were labelled as attachments.
- **Tapbacks can be taken back.** 2000–2007 add, 3000–3007 remove. Reading only
  the adds counts reactions that were removed. Order by date and keep the last
  state per (part, reactor). In one 154k-message chat this was 28 rows out of
  28,738 — worth doing for correctness, but it is *not* the explanation for
  inflated counts, and only 1 pair in 28,737 had a changed reaction. Measure
  before believing a theory about which of the two is happening.

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
- **URLs are not words, and they win if you let them.** A pasted link
  contributes its scheme, host and every path and query segment as separate
  tokens. Before this was fixed, `https` was the single most-used token in one
  chat (1,658), with `youtu`, `www` and `utm` close behind, and Instagram's
  share ids (`igsh`, `igshid`, plus strings like `gazm7xlppunwzle4tqno2q`)
  ranked as people's *signature vocabulary* — the section that is supposed to
  characterise someone was describing their link habits. `words()` in
  `analyze.mjs` strips URLs and emails first, then drops letter+digit mixes
  (ids) and bare numbers including ordinals and years. Matching only
  `https?://` is not enough: `instagram.com/reel/x` has no scheme, so the bare
  domain pattern matters too. Both the signature-word and picked-up-word
  passes call it, so they can never disagree. Validated on a 154k-message chat:
  the id soup goes, while `maye` (561), `duran` (351), `bregman` (311),
  `knicks` (510), `idno` (205) and `crochet` (215) all survive.
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
