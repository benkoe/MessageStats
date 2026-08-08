# MessageStats

A read-only tool for analyzing your own real iMessage history. Ask which
conversation the user wants; run the scripts; then do the part the scripts can't,
which is reading the output and following the interesting thread.

```
node serve.mjs                       # the web UI — http://127.0.0.1:4173
node build-names.mjs --write         # pull names from Contacts
node list-chats.mjs                  # metadata only — find the ROWID
node stats.mjs --chat <ROWID>        # the full analysis
node stats.mjs --chat <ROWID> --merge  # ... when the chat is split (see below)
```

`chat.db` and its `-wal`/`-shm` siblings live in this folder, alongside
`names.json` (names + handle aliases), which every script picks up
automatically. **Nothing here ever touches `~/Library/Messages`** — it works
on a Finder copy, which is why no Full Disk Access is involved.

## Preflight — do this first, every session

Two commands, a few seconds, before any analysis. Both are read-only.

```
node build-names.mjs        # dry run: is anything unnamed?
node list-chats.mjs --min 5000
```

Then tell the user, in a line or two, what you found:

- **Is the snapshot current?** `list-chats.mjs` shows each chat's last
  message date. If the newest is days old, say so — they may want to re-copy
  before you draw conclusions about "lately". See *Refreshing the copy*.
- **Are names filled in?** `build-names.mjs` prints "No new names" when
  everything in the chats is already in `names.json`. If it lists new ones,
  offer to run it with `--write`; a report full of phone numbers is much
  worse than one with names, and it is a five-second fix.
- **Any split identities?** The same dry run lists people whose contact
  record owns several handles that all appear in the messages. Those people
  are being counted as two, with half their history each, and every stat
  about them is wrong until it's merged. Flag it before analyzing, not
  after.

- **Any split *threads*?** `list-chats.mjs` prints a yellow
  `⚠ split across N threads` under any conversation that occupies more than
  one chat row — same people, different `chat_identifier`, because the group
  was recreated or renamed or an SMS thread forked off. It's common and it is
  not small: in one real corpus a two-person chat had **27%** of its history
  in a second thread under a different name, which also made the friendship
  look like it had ended months earlier than it had. Always re-run with
  `--merge` if the chat the user picked is flagged. `stats.mjs` warns on its
  own too, with the exact share you'd be dropping, but by then a ROWID has
  already been chosen.

- **Any roster churn?** A second, softer flag — `? same name, different
  roster` — means several threads share a display name but not a membership.
  **Ask before merging these.** A work group where people are added and
  removed as they join and leave the company is one conversation; a chat that
  deliberately excludes somebody — the group minus one person, to plan that
  person's birthday — is not, and the two are indistinguishable in the schema.
  Merging the second kind credits the excluded person with 0 of hundreds of
  messages they were never party to, quietly corrupting every per-person stat
  about them.

  When rosters differ, `stats.mjs` prints who was in which thread and when.
  **Read the per-year columns, not the totals** — someone present for only
  part of the span looks quiet, and anyone who *left* is missing from every
  roster while their messages remain, so a merged group can show senders who
  appear on no membership list at all.

  Confirmed decisions for this machine's copy live in `NOTES.local.md`, which
  is gitignored. Check there before asking a question that's already settled.

Names it can't find (numbers not in Contacts) are listed busiest-first. If
one of them has a lot of messages in the chat the user cares about, ask who it is
and add it to `names.json` by hand — don't just report a phone number as if
it were a person.

## What a session should actually do

Running `stats.mjs` is the start, not the deliverable. the user can run that
themselves. The value you add:

1. **Read the output and tell them the story.** Which numbers are surprising,
   which are funny, what they say about these people. Lead with the two or
   three that actually land; don't just reformat the table back at them.
2. **Follow up with ad-hoc queries.** "What were they arguing about that
   week", "who talks to whom most", "how did X's style change over the
   years" — none of that is a built-in section, and it's where this gets
   good. Write a throwaway `.mjs`, run it, delete it.
3. **Say when a number is an artifact.** Long chats accumulate junk:
   attachment-only messages whose text is object-replacement characters,
   auto-replies, a "most-reacted message" that's a photo. Call it out rather
   than presenting it straight.

## Writing an ad-hoc query — READ THIS FIRST

Always go through `lib.mjs`. Querying `chat.db` directly is how you get a
confident, wrong answer:

```js
import { openDb, messageText, appleMicrosToMs, DATE_TO_MICROS,
         REAL_MESSAGE_WHERE, loadIdentities, normalizeHandle } from "./lib.mjs";

const db = openDb("chat.db");
const { names, canonical } = loadIdentities("names.json");

const rows = db.prepare(`
  select m.text text, m.attributedBody body, h.id handle, m.is_from_me fromMe,
         ${DATE_TO_MICROS.replace("date", "m.date")} us
    from message m
    join chat_message_join j on j.message_id = m.ROWID
    left join handle h on h.ROWID = m.handle_id
   where j.chat_id = ? and ${REAL_MESSAGE_WHERE}
   order by m.date asc`).all(CHAT_ID);

for (const r of rows) {
  const text = messageText(r.text, r.body);      // NOT r.text
  const ms = appleMicrosToMs(r.us);
  const who = names.get(canonical(normalizeHandle(r.handle ?? ""))) ?? r.handle;
}
```

Four traps, each of which produces plausible nonsense rather than an error:

- **`message.text` is NULL for ~99% of rows.** The body is in
  `attributedBody` as a `streamtyped` NSArchiver blob. Read the column alone
  and every person appears to have sent a few dozen messages. Always
  `messageText(r.text, r.body)`.
- **`message.date` is NANOSECONDS since 2001-01-01** and exceeds
  `Number.MAX_SAFE_INTEGER` — reading it raw throws. Divide in SQL
  (`DATE_TO_MICROS`), then `appleMicrosToMs`.
- **A fifth of `message` rows aren't messages.** Tapbacks are
  `associated_message_type` 2000–2007 (3000–3007 = removed), and joins and
  renames are `item_type != 0`. `REAL_MESSAGE_WHERE` filters them. To join a
  tapback to its target, note `associated_message_guid` is prefixed —
  `p:0/ABC-123`, so split on `/` and take the tail.
- **One person can have two handles.** Someone messaging from an iCloud
  email while travelling splits into two people with half the history each.
  `names.json` has an `aliases` map; always fold through `canonical()`.

Also: outgoing messages have no `handle_id` (use `destination_caller_id` for
"me"), people who left a group still have messages but aren't in
`chat_handle_join`, and hour-of-day is in this machine's timezone.

`serve.mjs` is the browser front end; it renders `analyze.mjs`, the same
module `stats.mjs` prints from, so never teach one a number the other
doesn’t know. `README.md` has the full detail, including how to validate the
`attributedBody` parser against ground truth if it's ever changed.

## Handling the data

This is the user’s actual message history, including other people's messages.

- Print what's needed to make a point — a quoted line, a most-reacted
  message. Don't dump conversations wholesale, and don't page through
  someone's messages to satisfy curiosity that isn’t their question.
- It never leaves this machine. No uploading, no pasting into a web request,
  no committing.
- `list-chats.mjs` reads no message text at all, and that's structural: its
  SELECTs don't name `text` or `attributedBody`, and it doesn't import
  `messageText`. Keep it that way — browsing conversations without reading
  anyone's messages is worth preserving.

## Refreshing the copy

`chat.db` here is a snapshot. To update it: **quit Messages (⌘Q)** so the WAL
is flushed, then Finder ⇧⌘G → `~/Library/Messages` and copy `chat.db`,
`chat.db-wal`, `chat.db-shm` into this folder. All three — `chat.db` alone
opens fine and silently omits the most recent messages.
