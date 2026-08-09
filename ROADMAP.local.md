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

**Resolved 2026-08-09.** There is now exactly one data directory, the default
`~/Library/Application Support/MessageStats/`, populated through the app's own
setup flow like any other install. No `MESSAGESTATS_DATA` override is needed
and none should creep back in — a second directory is what made the counts in
this document require an override to reproduce in the first place.

---

## Phase 1 — pure SQL, no new parsing

Cheapest possible work: new columns, existing helpers, no new file formats.

### 1. ~~Group history — renames and membership~~ — DONE 2026-08-09

Shipped as the "Group history" card and a matching CLI section. The semantics
that were open are now settled, **confirmed against known events** (a person
`NOTES.local.md` records as having left, and a group whose rename date was
known):

| `item_type` / `group_action_type` | rows | meaning |
|---|---|---|
| 2 / 0 | 281 | **renamed** — new name in `group_title` |
| 1 / 0 | 115 | **added** — target in `other_handle` |
| 1 / 1 | 156 | **removed** — target in `other_handle` |
| 3 / * | 221 | **left** — the sender left; `other_handle` is 0 |
| 4, 5, 6 | 191 | still unidentified — no text, no target, no distinguishing column |

**The trap that makes this look like empty data: `other_handle` is a handle
`ROWID`, not a handle string.** Joining it against `handle.id` as text returns
nothing, and the obvious conclusion is that the column is unpopulated. Cast it
and join on `handle.ROWID`.

Two smaller things learned in the build. The same event is often recorded
twice, so collapse by (day, kind, target) or one departure reads as two. And
an add plus a remove of the *same* person on the same day is normally one
person switching handles — a new SIM or an iCloud address — which the alias
map folds under a single name; the UI says so rather than leaving it eerie.

This also paid down the debt it was supposed to: people who left keep their
messages but vanish from `chat_handle_join`, and the card now names them
explicitly instead of leaving a sender who appears on no membership list.

### 2. ~~True reply graph — `thread_originator_guid`~~ — DONE 2026-08-09

Shipped as the "Who replies to whom" card and CLI section: a people × people
matrix of who answers whom, with the median lag per edge, plus **gave** and
**got** columns. The gap between those two is the interesting part — in one
group chat the quietest replier draws 2,251 answers while giving 801, and the
most prolific replier gives 2,118 and draws half that.

Coverage is 2–9% per conversation (4.3% and 9.4% in the two largest), which is
thousands of edges and plenty — but the card **states its own coverage** rather
than letting a ranking built from 4% of messages read as the whole story.

Both metrics are kept, and renamed so they can't be confused: the adjacency
one is now "How fast people answer (inferred)" and says it assumes whoever
spoke next was answering; this one says it is exact. They had nearly identical
titles at first, which is worse than having only one.

Unlike `associated_message_guid`, this guid carries **no part prefix** — the
part is in `thread_originator_part`, which nothing needs. Self-replies are
dropped from the graph; answering yourself is not a relationship.

### 3. ~~Service mix~~ — DONE 2026-08-09

Shipped as the "How it's sent" card, **shown only when a conversation actually
mixes services** — an all-iMessage chat learns nothing from a column of 100%s.

Reported as **counts, not percentages**: in one 153k-message group RCS is 0.2%,
which rounds to "0%" and reads as *never* when it actually happened 290 times.
That chat also turned out to have a clean artifact — RCS appears for exactly
one week in January 2025 and never again, which the date span makes visible.

### 4. ~~Screenshot vs. camera~~ — DONE 2026-08-09

A "Camera or screen" table inside Attachments, with a screen-share percentage.
It is a real personality axis, not a volume restatement: in one group somebody
sends 344 camera photos and **zero** screenshots while another is 176 camera to
161 screenshots — half of what they send is their phone rather than their life.

Detection is by filename, since a screenshot and a photograph are both
`image/*` and identical by mime type: `IMG_`/`FullSizeRender`/`DSC`/`PXL` for
the camera, `Screenshot`/`Screen Shot` for captures, `RPReplay` for
recordings. Anything named otherwise — saved, forwarded, or from Android — is
counted in neither column, and the caption says so rather than implying the
two add up to everything.

Link cards remain **43% of all attachment rows**, which keeps re-confirming the
`attachmentKind()` decision to hold them out of media totals. Still unused:
`is_sticker` (785 rows).

### 5. Expressive effects — small, keep it small

401 rows total; the largest single effect is 132. Real but footnote-scale.
A one-line "who sends invisible ink" aside, not a section.

---

## Phase 2 — needs a binary-plist reader

Both items below are stored as `bplist00` inside an `NSKeyedArchiver` graph.
They are the two highest-value things in the database and they share one
dependency, so they should be planned together.

### ~~The dependency~~ — DONE 2026-08-09

`bplist.mjs`: the container reader plus the `NSKeyedArchiver` graph walker,
hand-rolled, no dependencies. `bin/check-bplist.mjs` validates it against
`plutil` on real blobs from the database — **1,600 checked, 0 failures**. Run
it after any change.

Writing the validator first was worth it twice over. It caught a real bug —
`Buffer.subarray()` returns a *view*, and `.swap16()` mutates in place, so
decoding a UTF-16 string silently corrupted the blob being parsed and damaged
the caller's buffer. And it proved the claim that `plutil -p` output is not
machine-readable: plutil does **not escape embedded double quotes**, so a
message containing `"buying"` splits into fragments under any regex. The check
compares by containment for exactly that reason.

### 6. ~~Rich link metadata — `payload_data`~~ — DONE 2026-08-09

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

**Shipped** as "What the links were": top sites, the most recent titles with
who sent them, and links sent more than once. In one chat, 5,278 of 5,330
previews kept their metadata. Two things learned in the build — the URL sits
under the dotted key `URL["NS.relative"]`, not a nested object; and social
cards embed their own layout in the title (`Name (@handle)\n3K likes · 26
replies`), so whitespace has to be collapsed before anything renders on one
line. Parsing ~5,300 archives adds about a second to a 153k-message chat.

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

## Phase 3 — ~~real but marginal~~ — DONE 2026-08-09

- **`chat.last_read_message_timestamp`** → "Never got back to them" on the
  overview. Incoming messages newer than the read mark, per conversation.
  Two things to know: the column is **nanoseconds since 2001** like
  `message.date`, so the arithmetic stays in SQLite; and the read mark can
  **predate this copy of the database** — pointers that survived a device
  migration show "read up to 2019" against a corpus that starts in 2022. The
  card says so rather than looking broken. Chats with the column at 0 have no
  read state and are left out, which is not the same as being caught up.
- **App/balloon mix** (`balloon_bundle_id`) → one line in Odds and ends, with
  the URL provider excluded because the link section already covers it. The
  bundle id is `…MSMessageExtensionBalloonPlugin:TEAMID:com.vendor.app`, so
  the readable name is the last dotted component of the last colon-separated
  field.
- **Audio messages** → one line, counts only, with "too few to read anything
  into" under 20. One chat had exactly one voice note, sent and played.
- **`associated_message_emoji`** → folded into the tapback card as "picked by
  hand". It turns "emoji 93" into 👀 15 · 🔥 14 · 🤮 11, which is the whole
  point of the column.
- **Recoverable (recently deleted)** — deliberately **not built**. 91 rows, and
  in the same sensitivity class as edit history, which was declined. Two
  reasons to leave it, either sufficient.

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
2. **`item_type` 4, 5 and 6** (88 / 27 / 76 rows) — still unidentified after
   the Phase 1.1 build. Sampled: no text, `other_handle` almost always 0, no
   column that separates them. Left out of the group history rather than
   guessed at. Likely candidates are location sharing and group-photo changes,
   but nothing in the data confirms it.
3. **Mentions.** No column holds them. They are presumably attribute ranges
   inside `attributedBody`, which is parsed for text only today. Unverified —
   check before promising an @-mention feature.

---

## Suggested order

1. ~~Fix the data-directory discrepancy~~ — done 2026-08-09.
2. ~~Group rename timeline + membership events~~ — done 2026-08-09.
3. ~~True reply graph~~ — done 2026-08-09.
4. ~~Service mix and screenshot/camera split~~ — done 2026-08-09.
   **Phase 1 is complete**, apart from the deliberately-skipped expressive
   effects (401 rows, footnote-scale).
5. ~~The bplist reader, then rich links~~ — done 2026-08-09.
6. ~~Phase 3~~ — done 2026-08-09.

**Everything in this document is now built or deliberately declined.** The two
declined items are edit history (Phase 2.7) and recoverable deleted messages —
both reconstruct what people wrote and then chose to unsay. The parser they
would need exists; the decision not to is the only thing keeping them out, and
it was made on purpose rather than by omission.

What's left is genuinely open ground rather than a backlog: the ideas in
`README.md` that were never specified (sentiment over time, who introduces
topics that catch on, message-length drift), the unidentified `item_type`
4/5/6, and whether mentions can be recovered from `attributedBody` attribute
ranges.
