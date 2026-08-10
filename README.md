# MessageStats

Point it at one conversation from a copy of your Messages database and it
finds everything interesting it can: who talks most, when, how fast they
reply, who gets reacted to, what words give each person away.

macOS only — it reads the Messages database, which is a macOS thing.

## Install

**Open `MessageStats.dmg` and drag MessageStats to Applications.** Then open
it like any other app. It's signed and notarized, so there's no warning to
click through.

It runs in its own window, with a Dock icon and ⌘Q like anything else —
closing it stops the server rather than leaving it running in the background.
No browser involved.

Two notes for whoever you send it to:

- **Actually drag it to Applications** — don't run it from the disk image.
  Full Disk Access is granted to an app where it currently sits, so granting
  it to a copy that only exists on a mounted image means it evaporates on
  eject, and the next launch asks again.
- **Full Disk Access:** System Settings → Privacy & Security → Full Disk Access
  → turn on **MessageStats**. That is what lets it copy your message database.
  Granting it to one small app is a much smaller ask than granting it to
  Terminal, which would give it to everything you ever run.

It needs **Node.js 24+** and **git** on the machine. If either is missing the
app says so and links to the download rather than failing silently.

**Updates are automatic.** The app bundle is a stub — the actual code lives in
`~/Library/Application Support/MessageStats/app` and the app runs `git pull`
*before* starting the server, so a launch always runs the current version. Push
to `main` and everyone gets it next time they open it, with no new download.

### Building it yourself

If you'd rather not run a binary someone sent you, clone this repo and run
`bin/make-app.sh` — it builds the same bundle locally. That copy is unsigned,
so macOS blocks it the first time: **right-click → Open**, once. Or skip the
app entirely and run `node serve.mjs`.

Building the window needs `swiftc`, which ships with the same Command Line
Tools as git. Without it you still get a working app, but it falls back to
serving the UI into your default browser — no window, no ⌘Q.

The DMG is the only *distributed* form on purpose. An earlier version shipped
an installer script that built a second copy on the recipient's machine, which
meant two bundles with the same identifier competing for one Full Disk Access
grant — confusing to grant and worse to debug.

### Cutting a release

Only needed when something in `bin/` changes; everything else ships via `git
pull`. Requires a Developer ID Application certificate and notary credentials
in your keychain — `bin/sign.sh` checks for both and tells you how to get them.

```
bin/sign.sh                  # → dist/MessageStats.dmg, signed and notarized
bin/sign.sh --skip-notarize  # fast local check; still Gatekeepered
```

### Running it directly

```
node serve.mjs        →  http://127.0.0.1:4173
```

If you haven't copied your database yet the page walks you through it, then
offers to pull names out of Contacts, then lets you browse, chart and search
every conversation you have.

There's a CLI too, if you'd rather:

```
node list-chats.mjs                  # find the conversation you want
node stats.mjs --chat 1259           # everything about it
node stats.mjs --chat 1259 --merge   # ...including its other threads
```

Both read the same `analyze.mjs`, so they can't disagree about a number.

## Is this safe?

It's your entire message history, so the question deserves a real answer
rather than a promise.

- **No dependencies.** No `npm install`, no lockfile, nothing to audit but
  the seven files here. SQLite comes from Node itself (`node:sqlite`).
- **Loopback only.** `serve.mjs` binds `127.0.0.1`, never `0.0.0.0`, so
  nothing else on your network can reach it.
- **Read-only.** The database is opened with `{ readOnly: true }`, and it's a
  copy anyway — this never touches `~/Library/Messages`.
- **Nothing personal is committed.** `.gitignore` covers `chat.db`, its
  `-wal`/`-shm` siblings, `names.json`, `ai.local.json` and `*.local.*`. Your
  history and your friends' names stay on your machine.
- **Exactly one feature can send data anywhere: the assistant**, and it is
  **off until you configure it**. Every other code path is local. The whole
  network surface is one `fetch` in `llm.mjs` — check for yourself:

  ```
  grep -rn "fetch(\|http.request\|net.connect" *.mjs
  ```

  With no `ai.local.json` and no provider env var, that call never runs.

**Delete the copy when you're done.** It's 1–2 GB of plaintext.

---

## The assistant (optional)

Ask questions about a conversation in plain English — "who wins arguments",
"what changed since 2023", "which of these numbers are artifacts". It gets the
**computed statistics**, not your message history: per-person rates, reply
matrices, signature words, rhythm, plus a handful of quotes the stats point at.
Roughly 6 KB per question.

**Set it up in the browser** — open the Ask panel at the bottom of any
conversation, choose a provider, paste a key, and press **Load models**. It asks
the provider what it actually has and gives you a dropdown, so you never type a
model id from memory and this project never carries a list that goes stale.

**Bring whatever you already pay for.** Built in: **OpenAI (ChatGPT)**,
**Anthropic (Claude)**, **Google Gemini**, Groq, OpenRouter, DeepSeek, Mistral,
Ollama, LM Studio — plus `custom` for anything else OpenAI-compatible. Keys can
come from the environment instead (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …).

**Pick the most capable model you're willing to pay for.** This is the one
setting that determines whether the answers are worth reading. The analysis is
mostly *noticing* — that the fastest replier is also the most disliked person,
that a 6x growth curve is one person's arc, that a word only one person uses is
the joke. Cheap models report the numbers back; capable models find the story.
A question costs roughly 6 KB of input, so the price difference per question is
fractions of a cent — optimise for quality here, not cost.

**Local models are the privacy option, not the quality option.** `ollama` and
`lmstudio` are the same OpenAI-compatible adapter pointed at localhost, so they
need no key and send nothing anywhere. A small local model will tell you someone
replies quickly; it will not notice why that's funny. Use one when the guarantee
matters more than the answer — otherwise use a hosted model.

**Every request is logged** to `ai-sent.local.jsonl` (gitignored) with the full
text that was sent, so you can check exactly what left rather than trust a
claim in a README.

---

## Setup

**Node 24+** (uses the built-in `node:sqlite`; on 22.5–23 you'd need
`--experimental-sqlite`). No dependencies, no `npm install`.

**Get the database.** This tool never reads `~/Library/Messages` — that
would need Full Disk Access, and it's the live database. Instead:

1. **Quit Messages** — ⌘Q, not just closing the window. Otherwise recent
   messages sit unflushed in the write-ahead log and the newest history is
   silently missing.
2. In Finder, ⇧⌘G → `~/Library/Messages`
3. Copy **all three** files into
   `~/Library/Application Support/MessageStats/`:
   - `chat.db`
   - `chat.db-wal`
   - `chat.db-shm`

All three matter. `chat.db` alone opens fine and quietly omits whatever was
still in the WAL — which is exactly the most recent stuff you care about.

That folder, not the repo, is where your data lives — `git pull` replaces the
repo wholesale on every launch, so nothing of yours can survive inside it.
`names.json`, `ai.local.json` and `NOTES.local.md` live there too. Set
`MESSAGESTATS_DATA` to use a different folder, or pass
`--db /somewhere/else/chat.db` for a one-off.

**Delete the copy when you're done.** It's your entire message history, in
plaintext, typically 1–2 GB.

---

## Naming people

**Start here:** `node build-names.mjs --write` pulls names straight from
macOS Contacts, so you rarely have to write any of this by hand.

It only writes people who actually appear in your messages (your address
book is bigger than your chat history, and there's no reason to copy the
rest into a file), and it **auto-detects aliases** — when one contact record
owns two handles that both show up in your messages, it folds them together.
That case is otherwise invisible: the person is silently counted as two
people with half their history each. Existing entries always win, so
anything you wrote by hand survives.

Contacts live in `~/Library/Application Support/AddressBook`, in several
SQLite files — usually one real one under `Sources/<UUID>/` and a few empty
shells. The script scans them all.

### Doing it by hand

`chat.db` has no contact names — those live in the AddressBook database,
which this tool deliberately never touches. So people show up as phone
numbers and emails until you tell it who they are.

Create `names.json` next to the scripts (both scripts pick it up
automatically; override with `--names path.json`):

```json
{
  "names": {
    "(617) 555-0100": "Alice",
    "1 (508) 555-0142": "Bob",
    "1 (617) 555-0199": "Me"
  },
  "aliases": {
    "alice@icloud.com": "(617) 555-0100"
  }
}
```

Write phone numbers however you like — `(617) 555-0100`, `+16175550100`,
`16175550100` all normalize to the same key.

**`aliases` is the one that matters and is easy to miss.** People change
handles: someone messaging from their iCloud email while travelling appears
as a *second person* with half their history. Every stat then splits between
two ghosts and the totals lie. An alias folds one handle onto another so
they count as one person everywhere. Point the alias at their **phone** by
preference.

Include yourself under `names` (find your number in your own outgoing
messages) or you'll show up as "Me".

---

## What it prints

| Section | |
|---|---|
| Messages per person | all-time and per year |
| Busiest stretches | day, week, month, single hour, longest streak of consecutive days, longest silence and who caused it |
| When they talk | hour-of-day, day-of-week, per-person peak hour, who's up at 2am |
| Message length | average, median, longest ever with the text |
| Conversation dynamics | who starts, who gets the last word, median reply time, double-texting rate, longest monologue, fastest reply ever |
| Who answers whom | median reply time for every pair — who jumps for whom |
| Tapbacks | given/received/ratio per person, and the most-reacted messages |
| Most-used words | top words per person, stopwords stripped |
| **Signature words** | words each person says *far more than everyone else* — the section that actually characterizes people |
| Emoji | overall and per person |
| Odds and ends | laugh rate, question rate, ALL-CAPS shouting, links and top domains, vocabulary size, most-repeated messages, first and latest message |

Flags: `--top N` (words per person, default 10), `--names path`, `--db path`,
and for [trap 4](#4-one-conversation-several-chat-rows): `--merge` (fold in
sibling threads holding exactly the same people) or `--merge 2488,2987,3676`
(fold in these rows explicitly, whatever their rosters).

`list-chats.mjs` also takes `--min N` (hide small chats), `--limit N`,
`--search text`.

---

## How it works, and the traps

Anyone extending this — human or model — should read this part. Three of
these will silently produce a *plausible but wrong* result rather than an
error.

### 1. Message text is almost never in the `text` column

**This is the big one.** On modern macOS `message.text` is usually NULL and
the body lives in `message.attributedBody` as an archived
`NSAttributedString`. On the corpus this was built against, **only 0.87% of
rows (7,724 of 890,482) had usable `text`.**

A tool that reads `text` and skips NULLs doesn't crash — it reports that
everyone sent about forty messages and looks merely boring.

`messageText()` in `lib.mjs` handles it. The blob is a **`streamtyped`
archive (NSArchiver)** — *not* a plist and *not* NSKeyedArchiver, so
`plutil` and plist libraries return nothing. The body sits after an
`NSString` marker as `0x2B <length> <utf8>`, where length is one byte under
128, or `0x81` + uint16 LE, or `0x82`/`0x83` + uint32 LE.

**If you change that function, validate it like this:** select rows where
*both* `text` and `attributedBody` are non-null, extract from the blob, and
compare to the column. It should match byte-for-byte. That comparison is the
only thing that distinguishes a working parser from one confidently
returning the wrong substring. (It was 7,724/7,724 exact when written.)

### 2. Dates are nanoseconds since 2001, and overflow JS numbers

`message.date` is nanoseconds since the **Apple epoch (2001-01-01)**, not
Unix. Values run around 6.7e17 — past `Number.MAX_SAFE_INTEGER`, so reading
the raw column into JS **throws**.

Every query divides it down in SQL (`date / 1000`, to microseconds) before it
reaches JS. Add `978307200` seconds to convert to Unix.

Very old databases (pre-High Sierra) stored *seconds* instead. If dates come
out in 2001, that's why.

### 3. A fifth of the rows aren't messages

Tapbacks, stickers, joins and renames all live in the `message` table.

- `associated_message_type = 0` → a real message someone typed
- `2000–2007` → a tapback/sticker being **added**
- `3000–3007` → one being **removed**
- `item_type != 0` → joins, renames, other system rows

`REAL_MESSAGE_WHERE` filters to real messages. Count them all as messages and
the record fills with "Liked 'sounds good'" lines attributed to people as
things they said.

The tapback section counts them separately, and joining them back to their
target has its own trap: **`associated_message_guid` is prefixed** — it looks
like `p:0/ABC-123`, not `ABC-123`. Split on `/` and take the tail, or every
lookup misses and everyone appears to receive zero reactions.

### 4. One conversation, several chat rows

A group gets recreated, someone renames it, an SMS thread forks off an
iMessage one — and iMessage mints a new `chat` row with a new
`chat_identifier`. The old row keeps its history, the new row collects
everything since, and `list-chats.mjs` shows them as two unrelated
conversations because their display names differ.

This is the trap with the largest blast radius, because nothing looks wrong.
In one real corpus, two chats with different display names — a group that had
been renamed — turned out to be the same two people. Analyze only the bigger one and you
drop **27%** of the relationship — and since the split happened in April
2025, the conversation appears to simply stop in February 2026.

`findSiblingChats()` in `lib.mjs` links chats on either of two signals, then
unions them transitively.

**`chat.original_group_id`** is the strong one — Apple's own identity for a
group, preserved across renames, recreations and SMS fallback. It links a work
group through staff changes (rosters differ, same group) and, crucially, does
*not* link a deliberately-separate chat that merely shares members. In this
corpus it ties 15 pairs together, two of which the roster signal alone misses.
It is null on older rows, which is why the second signal exists.

**An identical canonical participant set** (handles folded through
`names.json` aliases) covers the rest. That half is deliberately strict: a
thread someone left or joined has a different set and won't match, because
silently merging those would change who the conversation is *about*.

`list-chats.mjs` flags splits inline; `stats.mjs` warns with the exact share
you'd be dropping and folds them together on `--merge`. Merging dedupes by
`message.guid`, because `chat_message_join` can in principle link one message
to several chats.

**The looser tier, which is report-only on purpose.** Threads can also share a
*name* while their rosters differ — a work group that adds and removes people
as they join and leave. `findSameNameChats()` surfaces those as
`? same name, different roster`, and deliberately stops there.

Roster overlap is not a safe merge signal. In one real corpus a 42,856-message group had
86% roster overlap with four small chats whose names all followed the pattern
`W/O <name>` — the group deliberately minus one person, for planning that
person’s birthday. Nothing in the schema distinguishes "staff churn"
from "deliberately excluding someone", so the tool never guesses. Requiring an
identical display name filters the exclusion chats out (they get renamed), but
only a human knows for sure:

```
node stats.mjs --chat 2488 --merge 2488,2987,3676
```

When merged rosters differ, `stats.mjs` prints which people were in which
thread over which dates, because per-person *totals* become misleading — read
the per-year columns instead. Note also that anyone who **left** is gone from
every roster while their messages remain (see trap 5), so a merged group can
show senders who appear on no membership list.

### 5. Smaller things

- Outgoing messages have **no `handle_id`**. "Me" is identified from
  `destination_caller_id` on your own messages.
- `chat.style` is `43` for groups, `45` for 1:1.
- People who left the group still have messages but are absent from
  `chat_handle_join` — always derive participants from actual senders, not
  the roster.
- Every date and clock time uses the **local timezone of the machine running
  this**, not wherever anyone was at the time. `message.date` is an absolute
  instant and the schema records no timezone at all, so the sender's own clock
  cannot be recovered: a 2am message from Rome is filed as an 8pm message in
  New York. Reports print the timezone they used.

---

## Files

```
lib.mjs           database, dates, attributedBody parsing, names/aliases, formatting
list-chats.mjs    conversation picker — METADATA ONLY, never reads message text
stats.mjs         all the analysis
names.json        yours to create (see above)
```

`list-chats.mjs` not reading message text is structural, not a promise:
every SELECT names its columns, none names `text` or `attributedBody`, and
it doesn't import `messageText`. Keep it that way — being able to browse
conversations without reading anyone's messages is worth preserving.

## Adding a stat

`stats.mjs` loads everything into `msgs` once — an array sorted by time of
`{ guid, who, ms, text, len }` — and every section is an independent pass
over it. Add a section by adding a loop and a `head("...")`. Helpers you'll
want: `inc`, `topN`, `median`, `human` (durations), `pct`, `bar`, `quote`,
`day`, `pad`/`padL`.

Ideas not implemented yet: sentiment over time, who introduces topics that
catch on, response-time trends by year, whether anyone's message length is
drifting, group mood by month, longest conversation without a gap.
