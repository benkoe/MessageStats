# Roadmap — unexploited schema, and the order to adopt it

Kept off `main` for the same reasons as `CLAUDE.local.md`: it lives on the
`docs` branch, is gitignored here via `*.local.md`, and contains **nothing
identifying** — aggregate counts only, no names, no handles, no message text,
no shared URLs. Same restore/backup recipes as that file.

`CLAUDE.md` covers analysis traps. `CLAUDE.local.md` covers build and release.
This covers *what the database still has that we don't read*.

---

## Status: verified, not yet built

Every count below was measured against the reference copy on **2026-08-09**
(890,529 messages) with read-only queries. Nothing here is inferred from
documentation or memory — where a claim could not be confirmed it is listed
under *Unknown* rather than planned.

That corpus is a modern schema: it carries `RCS`, `associated_message_emoji`,
`schedule_type` and `is_kt_verified`. **Every column below still needs a
`hasColumns()` guard** — the same Ventura lesson from `CLAUDE.local.md`, since
these are newer still and an older copy will not have them.

### Where the data actually is

The scripts default to `~/Library/Application Support/MessageStats/`, which on
this machine holds only the installed `app/` clone. The database is one
directory over, in **`MessageStats-real/`**. Until that is reconciled, every
command needs:

```
export MESSAGESTATS_DATA=~/Library/Application\ Support/MessageStats-real
```

Reconciling it is a prerequisite for all of the below, and is the one item
here that is a bug rather than a feature.

---

## Phase 1 — pure SQL, no new parsing

Cheapest possible work: new columns, existing helpers, no new file formats.

### 1. Group history — renames and membership

Events live in `message` with `item_type <> 0` (969 rows total):

| `item_type` / `group_action_type` | rows | meaning |
|---|---|---|
| 2 / 0 | 281 | **rename** — new name in `group_title` |
| 1 / 1 | 156 | participant change |
| 1 / 0 | 115 | participant change |
| 3 / 1 | 130 | participant change |
| 3 / 0 | 82 | participant change |
| 4 / 0 | 88 | *unverified* |
| 6 / 0 | 76 | *unverified* |
| 5 / 0 | 27 | *unverified* |

`group_title` is non-null on 288 rows across **67 distinct chats**, so a
"every name this group has ever had" timeline is real and immediately
buildable. Renames are the confirmed half; ship that first.

Adds vs. removes across `item_type` 1 and 3 are **not** yet distinguished —
the `group_action_type` split does not map cleanly onto the two `item_type`
values, and guessing here produces a confidently wrong roster history. Resolve
by reading a handful of known events before labelling anything in the UI.

This also pays down an existing debt: `CLAUDE.md` documents that people who
left a group keep their messages but vanish from `chat_handle_join`. A
membership timeline explains those senders instead of leaving them as ghosts.

### 2. True reply graph — `thread_originator_guid`

39,827 non-null, of which **39,774 (99.87%) resolve** to a real `message.guid`.
This is the genuine inline-reply edge.

`analyze.mjs:437` currently infers replies from time adjacency, which conflates
"answered you" with "happened to speak next". Keep the adjacency metric — it is
the only thing available for the other 95% of messages — but add the exact
graph beside it and label the two differently. They answer different questions
and silently merging them would make both untrustworthy.

### 3. Service mix

| service | messages |
|---|---|
| iMessage | 847,599 |
| SMS | 35,352 |
| RCS | 7,577 |
| iMessageLite | 1 |

Per-person and per-chat green-bubble share, and RCS adoption over time. Trivial
`group by`.

### 4. Screenshot vs. camera

`attachment.transfer_name` separates cleanly, and the split is a genuine
personality axis rather than a volume restatement:

| pattern | count |
|---|---|
| link card (`*.pluginPayloadAttachment`) | 37,561 |
| `IMG_*` | 28,479 |
| screenshot | 3,936 |
| `FullSizeRender*` | 112 |
| screen recording (`RPReplay*`) | 32 |
| other | 17,185 |

Link cards are **43% of all 87,305 attachment rows**, which re-confirms the
`attachmentKind()` decision to hold them out of media totals. Also available
and unused: `is_sticker` (785 rows).

### 5. Expressive effects — small, keep it small

401 rows total; the largest single effect is 132. Real but footnote-scale.
A one-line "who sends invisible ink" aside, not a section.

---

## Phase 2 — needs a binary-plist reader

Both items below are stored as `bplist00` inside an `NSKeyedArchiver` graph.
They are the two highest-value things in the database and they share one
dependency, so they should be planned together.

### The dependency

Node has no bplist parser and the project is deliberately zero-dependency
(`lib.mjs` is plain ESM over `node:sqlite`). Two options:

- **Hand-rolled reader (recommended).** Roughly 200–300 lines for the bplist
  container, plus a second layer to walk the `$objects`/`$top` graph that
  `NSKeyedArchiver` wraps everything in. Same class of work as the existing
  `streamtyped` parser, and `README.md` already documents how to validate a
  parser of this kind against ground truth — follow that.
- **Shell out to `plutil`.** Works, but costs a process spawn per blob (19,566
  for links alone), and its `-p` output is not machine-readable while
  `-convert json` has to be checked against archiver UIDs and non-UTF8 bytes.
  Acceptable for one-off ad-hoc queries; wrong for a report path.

### 6. Rich link metadata — `payload_data`

19,566 non-null, essentially all from `com.apple.messages.URLBalloonProvider`
(19,397). **19,212 contain a `title` key.** Decoding one confirmed the object
is an `LPLinkMetadata` carrying:

- the resolved URL
- the page **title**
- a **summary/description** line
- the **site name** (human-readable, e.g. the publication)
- a content type (`article`, …)
- preview image URL(s) and image mime type

This turns the existing domain histogram into an actual reading list, and it is
all captured **at send time and stored locally** — so it needs no network. That
matters beyond convenience: fetching a shared URL to get its title would leak
the contents of a private chat to whoever runs that domain, and would break the
never-leaves-this-machine rule outright. `payload_data` is the offline answer
and is the only acceptable one.

Caveat found while sampling: some payloads are placeholders
(`richLinkIsPlaceholder = true`) with no metadata. The 19,212-with-title figure
is the honest denominator; do not report link titles as a share of all links.

### 7. Edit history — `message_summary_info`

**Corrected from an earlier guess.** `message_summary_info` is non-null on
863,595 rows, but that is not edit history — the common case is a 61-byte
`{amc, ust}` record with no analytic content. Length alone does not separate
them, and a two-character `instr()` probe for `'ec'` matches binary noise;
don't use one.

The real signal: of 5,011 messages with `date_edited > 0`, **4,366 contain a
`streamtyped` archive inside `message_summary_info`**, under an `ec` key
holding per-revision `d` (date) and `t` (text) entries. So prior versions are
recoverable for ~87% of edits, with timestamps.

The payoff for effort here is unusually good: once the bplist wrapper is read,
the inner text is `streamtyped`, which **`lib.mjs` already parses**. No second
text parser.

`otr` is *not* the original text — it is a range (`le`/`lo`). Don't reach for it.

**Judgement call before building.** This reconstructs what people wrote and
then chose to unsay. It is the most sensitive thing in the database by some
margin, and "we can" is not "we should". At minimum it should not appear in a
default report; my recommendation is that it stays an ad-hoc query and never
becomes a section. Worth an explicit decision from you rather than a default.

---

## Phase 3 — real but marginal

- **`chat.last_read_message_timestamp`** — populated for 1,513 of 1,855 chats.
  Supports a library-wide "which conversations am I ignoring" view, which is
  one of the few things here that works across the whole corpus rather than
  per-chat.
- **App/balloon mix** (`balloon_bundle_id`) — dominated by the URL provider
  (19,397). The tail is genuinely small: a third-party poll extension 215,
  Find My 47, Apple's Polls 37, Photos 29, Apple Cash 11, then single digits
  for payments, games and maps. Worth one line, not a section.
- **Recoverable (recently deleted)** — `chat_recoverable_message_join` has 91
  rows, `recoverable_message_part` has 1. Present, tiny, and arguably in the
  same sensitivity class as edit history. Low priority on both counts.
- **Audio messages** — 129 total, 78 played. This is exactly the situation
  `MIN_READ_SAMPLE` exists for: report the absence, never a median.
- **`associated_message_emoji`** — 3,291 rows. Custom-emoji tapbacks are
  invisible to the current 2000–2007 tapback logic; worth folding in when
  tapbacks are next touched.

---

## Confirmed dead ends — do not build

Measured as empty or useless in this corpus. Recorded so nobody re-investigates:

- `date_retracted` — **0 rows.** Confirms the existing note in
  `CLAUDE.local.md`; unsends are not recoverable here.
- `is_spam` — 0. `schedule_type` — 0. `deleted_messages` — 0 rows.
- `has_unseen_mention` — 306, and it means *unseen*, not *mentioned*. It is not
  a mention count and must not be presented as one.
- `syndication_ranges` — 727 rows; not investigated, likely Shared-with-You.

---

## Open questions — resolve before building on them

1. **`reply_to_guid` semantics are unknown.** 636,664 non-null and ~99.9% of a
   20,000-row sample resolve to a real message — but it is present on 70% of
   *all* messages across every service, so it cannot mean "this is a reply".
   It is not `thread_originator_guid` (26,230 rows carry both). Until someone
   characterises it, do not use it for anything. It is the single most
   dangerous column in this document precisely because it looks meaningful and
   resolves cleanly.
2. **`item_type` 4, 5 and 6** (88 / 27 / 76 rows) — unlabelled above on
   purpose.
3. **Mentions.** No column holds them. They are presumably attribute ranges
   inside `attributedBody`, which is parsed for text only today. Unverified —
   check before promising an @-mention feature.

---

## Suggested order

1. Fix the data-directory discrepancy (blocks everything).
2. Group rename timeline + membership events — Phase 1.1, and it fixes the
   existing ghost-sender gap.
3. True reply graph — Phase 1.2, highest analytic value per line of SQL.
4. Service mix and screenshot/camera split — Phase 1.3–1.4, near-free.
5. Decide the bplist question, then rich links — Phase 2.6.
6. Edit history **only after an explicit decision** — Phase 2.7.
