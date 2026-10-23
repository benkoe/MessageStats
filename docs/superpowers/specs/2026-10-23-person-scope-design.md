# Person scope for the assistant — design

Date: 2026-10-23. Status: reviewed; builder-check questions resolved below.

## Intent

The assistant can only quote the two or three lines a report happens to
surface. Both existing scopes are fed computed statistics: `brief()` carries a
conversation's numbers plus a handful of quoted lines (longest message, fastest
reply pair, most-repeated, most-reacted, recent link titles, and up to 25 hits
when a search term is typed); `libraryBrief()` carries the Everything page and
no text at all. Nothing in the app can answer "what is this person like" from
what they actually said, and nothing can look at one person across the 1:1
thread *and* every group they are in.

The request that surfaced the gap was a wedding roast. The gap is general: the
assistant should be able to read actual messages to answer whatever is asked,
in whatever tone is selected. Roast is one tone, not a feature.

## Goals

- A third assistant scope, **person**: pick someone and ask about them across
  every conversation they appear in — their 1:1 thread (all sibling rows) and
  every group they have sent a message in.
- The brief for that scope carries **real message text**, selected so that
  most questions a person would ask have material to answer from, with the
  selection rule stated in the brief.
- Question-driven retrieval: words from the question and any typed search term
  pull matching messages in, across all their threads.
- The existing **chat** scope gains the same excerpt layer for that one
  conversation, so every scope except Everything reads actual messages.
- Same ask panel, tones, in-flight handling, history and export as today.

## Non-goals

- Everything (library) scope stays numbers-only. The whole library has no
  bounded selection and `overview()` deliberately never opens a message.
- No second LLM call to plan retrieval. One request per ask, as now.
- No embeddings, no vector index, no new dependencies. Substring search, like
  `search()`.
- No change to the CLI's `stats.mjs` output beyond what falls out of sharing
  code. There is no CLI person report in this piece of work.

## Anti-goals

- **A random or truncated dump.** Feeding the first N or the latest N messages
  answers nothing reliably and reads as if it were the whole record.
- **A model that treats the subset as the full record.** The brief must say
  what it is and how it was chosen.
- **Silent growth in what leaves the machine.** This ships noticeably more of
  someone's actual words to the configured provider. The answer must say how
  much text was sent, and the ask box must say, once, that this scope sends
  message text.
- **Two frontends disagreeing.** Selection lives in one function in
  `analyze.mjs` so a future CLI report and the app cannot drift.

## Constraints (from the codebase; see CLAUDE.md and CLAUDE.local.md)

- Go through `lib.mjs`: `messageText()`, `DATE_TO_MICROS` + `appleMicrosToMs`,
  `REAL_MESSAGE_WHERE`, `canonical()` through `names.json` aliases, `day()`
  and `TZ` for every date. Everything is local time and says so.
- A person is identified in URLs, API calls and cache keys by a **canonical
  handle**, and their messages are selected by the **display name** that
  handle resolves to (`who` in `loadMessages()`), which is how every other
  stat in the app is keyed. The two diverge only when two handles share a
  name without an alias, which is the split-identity trap Settings already
  warns about; the person view inherits that behaviour rather than fixing
  it. The history key is `person:<name>` so that adding an alias later does
  not orphan saved answers. `loadMessages()` does not change.
- **Anyone in the library can be a person**, not only the Everything page's
  top twelve. `overview()` only knows people with a 1:1 chat, and `shape()`
  drops `handle`, so the plan needs a cached **people directory**: every
  canonical handle that has sent a message, with name, total messages, and
  the list of chats they have sent in. Built the way `status()` groups
  `message.handle_id` by canonical handle, cached under `invalidate()`, and
  served as `GET /api/people`. The Everything table and the sidebar search
  both resolve through it. Name collisions (two handles, one name, no alias)
  list once, under the busier handle.
- Do not use `chat_handle_join` to find their groups:
  people who left a group are absent from the roster while their messages
  remain. "Every conversation they are in" = every chat with at least one
  message *from* them, plus the 1:1 chats whose counterpart is them, folded by
  the same sibling rule the sidebar uses **and** by the remembered decisions
  in `merges.local.json`, the way `openChat()` applies them. A group the user
  merged by hand must not appear twice in the person's thread table with its
  stats split. The brief cache key is therefore (handle, combine, a digest of
  the merge file), and `invalidate()` on a merge change clears it.
- **Thread floor.** A thread is loaded and gets a row only if they sent at
  least 10 messages in it. Threads below the floor are not loaded; the header
  says "also appears in N other conversations with fewer than 10 messages
  from them" so the count is sayable without the cost. One stray message in a
  60k-message group must not cost a full scan of that group.
- Tapbacks: 2000–2007 add, 3000–3007 remove; keep last state per (part,
  reactor); `associated_message_guid` is `p:N/<guid>`, split on `/`. Count
  distinct reactors per message. The existing loader in `analyze()` (around
  the `reactors` map) is the reference; reuse or extract it rather than
  re-deriving.
- Outgoing messages have no `handle_id`; "me" comes from
  `destination_caller_id` via `resolveMe()`.
- `serve.mjs` is single-threaded and the ask route already blocks on
  `chatDetail()`. A person brief for someone in thirty groups is thirty
  `loadMessages()` calls; cache the built brief per (handle, combine) under
  the existing `invalidate()` so repeated asks about the same person cost one
  scan. Budget: the brief should build in a few seconds on a 700k-message
  library; measure on a real one before shipping.
- Async renders in `ui/index.html` capture `PAGE` first and bail if it moved.
  In-flight asks live in `ASKS`, keyed; the key for this scope must not
  collide with a chat ROWID or `"library"`.
- `markdown()` builds DOM nodes only. Model output is never markup.
- Nothing identifying in docs that go to the public `docs` branch.

## The excerpt layer

One function, `excerpts(msgs, opts)` in `analyze.mjs`, takes the ordered
message list(s) for a scope plus tapback state and returns a list of
`{thread, who, ms, text, why}` lines. `why` is a short tag naming the rule
that picked it (`reacted`, `laughed-at`, `longest`, `repeated`, `unanswered`,
`spread`, `search`). It is used by both scopes:

- **chat scope**: `msgs` is the one conversation; `who` is everyone.
- **person scope**: `msgs` is the union over their threads; only *their*
  messages are candidates, but the surrounding lines (one before, one after)
  are included for context on reacted and laughed-at picks so the model can
  see what they were answering.

Selection rules, in priority order, each capped so no single rule fills the
budget:

1. **Reacted.** Messages with the most distinct reactors, laugh tapbacks
   weighted above the rest. Meaningless in a 1:1 (max one reactor), so the
   rule applies to groups only.
2. **Laughed at.** Messages followed within five minutes by a message from
   someone else matching `LAUGH` (already in `analyze.mjs`). This is the 1:1
   equivalent of rule 1 and also applies in groups.
3. **Longest.** Top few by character length per thread.
4. **Repeated.** Their most-repeated exact messages (normalised: trimmed,
   lower-cased), with count.
5. **Unanswered.** Their messages followed by their own next message more than
   an hour later with nothing from anyone else in between, in groups only.
   Capped small; this is colour, not the core.
6. **Spread.** A deterministic sample stratified by thread and by year so every
   thread and every year has some representation, filling whatever budget is
   left. Deterministic (e.g. every k-th message of the stratum) so the same
   question twice gets the same brief.
7. **Search.** Words from the question plus any typed search term, run over
   their messages across all threads. Question words are tokenised the way
   `words()` in `analyze.mjs` does (stop words, URLs, numbers dropped), and
   only tokens of four or more characters are searched. Search hits are added
   on top of the budget, capped separately, newest first. Each hit records the
   term that matched.

Attachment-only lines (object-replacement characters), link cards and app
balloons are not candidates. Exact duplicates across rules are collapsed; a
line picked by two rules carries both tags.

Budget: a character budget rather than a line count, default **40,000
characters** of excerpt text for the person scope and **20,000** for the chat
scope, because a line can be a word or a paragraph. These are constants at the
top of `serve.mjs` next to `maxTokens`, not settings, for now.

Local providers are the exception to "not a setting": Ollama's default
context window is a few thousand tokens and it truncates from the **front**
of the prompt, which is where the grounding rules and the "this is a subset"
preamble sit. When `cfg.local` is true the excerpt budget drops to a quarter
and the ask panel says so in the disclosure line ("a smaller selection,
because the local model's context is short"). A per-provider budget table is
out of scope; one flag, two numbers.

Each line is rendered into the brief as
`YYYY-MM-DD · <thread name> · <who>: <text>` with the text truncated at 400
characters and an ellipsis. Tags are not printed per line; the brief has a
preamble that explains the rules and the counts picked by each, which is
enough for the model to know what it is looking at.

## The person brief

`personBrief(P)` in `serve.mjs`, built from a new `personDetail(handle, {combine})`
in `serve.mjs` that calls into `analyze.mjs`. Sections, in order:

1. **Header.** Name, also-known-as (other handles folded in), total messages
   by them across the library, span, the number of threads they appear in, the
   timezone line.
2. **Per thread.** One line per conversation (1:1 first, then groups by their
   message count): thread name, their count and share of that thread, by year,
   their peak hour, median reply time, double-text / laugh / question rates,
   signature words and top emoji *in that thread*. **Not** a full `analyze()`
   per thread: that runs ten further SQL scans (attachments, links, apps,
   audio, edits, group events, receipts, reply threads) the row never uses,
   and thirty of them on big groups is a minute on a single-threaded server.
   Everything the row needs is computable from `msgs` alone. Extract the
   per-person block of `analyze()` (around the `laughs`/`questions` maps)
   into a `personRow(msgs, who, opts)` that `analyze()` itself calls for its
   `perPerson` output, so the report and the person view print the same
   number for the same thread because they run the same code. Signature
   words need the whole thread's word counts for the ratio; compute them
   from the same `msgs`.
3. **Excerpts.** The preamble (what this is, how it was chosen, counts per
   rule, that it is a subset) followed by the lines, grouped by rule in the
   order above, search hits last under the term they matched.
4. **What is not here.** The numbers for other people in those threads, the
   full text of anything, and anything in threads they never sent a message in.

The system prompt gets a third `AI_SCOPES.person` line stating that the
context is one person across many conversations, that it contains real quoted
messages chosen by the rules in the brief, that quotes must be verbatim from
the context, and that anything not quoted must be described as "the
excerpts" rather than "their messages".

The chat scope's `brief()` gains the excerpt section after the existing quoted
lines, with the same preamble, and `AI_RULES` is reworded: it currently opens
with "You are given computed statistics, not raw message history". It should
say the context is statistics plus a chosen subset of real messages, and that
quotes must be verbatim. The library scope line stays as is.

## Server

- `GET /api/person?handle=…&combine=…` returns `personDetail()`: the header,
  the per-thread rows and the thread list (id, name, their count, span). The
  page renders from this; the excerpts are not returned here, they are built
  on ask.
- `POST /api/ai/ask` takes `scope: "person"` with `handle`, `combine`,
  `question`, `search`, `tone`. `aiAsk()` builds `personBrief()`, subject is
  the person's name, history key is `person:<canonical handle>`.
- The chat branch of `aiAsk()` passes the loaded messages and tapback state to
  `excerpts()` and hands the result to `brief()`.
- Both briefs are cached under `invalidate()`; the search layer is not cached
  since it depends on the question.
- `contextChars` is already returned per answer. Add `excerptChars` so the UI
  can print "sent N characters of message text".

## UI

- **Entry.** A name on the Everything page's people table opens the person
  view (today it opens their busiest 1:1 chat; that link moves to a
  secondary "open conversation" link on the person page). The sidebar search
  box also matches people by name and offers "ask about <name>" when a typed
  name matches an `overview()` person.
- **Person page.** Header, a table of their threads (name, their messages,
  share, span; each row opens that conversation), then the ask panel. No
  charts in this piece of work; the page exists to hold the ask.
- **Ask panel.** `askPanel(personAsk(P))` with key `person:<handle>`, its own
  placeholder and suggestions. Suggestions differ *in kind* from the other two
  scopes: they are about the person across rooms ("how are they different in
  the group chat vs one-on-one", "what do they bring up unprompted", "write
  their introduction"). The search field is rendered, as on chat.
- **Disclosure.** One line above the question box, present on chat and person
  scopes: "This sends a selection of actual messages to <provider label>" (or
  "nothing leaves this machine" when the provider is local, reusing the
  existing `local` flag). Each answer shows the excerpt character count next
  to the existing context size.
- **Sidebar dot.** `markAsking()` needs a target for `person:` keys; the
  Everything button is the reasonable anchor since the person view is reached
  from there.
- Hash routing: `#person=<handle>` so reload and back work the way
  `#settings` does, with the same generation guard.

## Documentation to update in the same commit

- `CLAUDE.local.md`: a section under "The assistant" on the three scopes and
  the excerpt layer — what it picks, why not a dump, the budget, the "say what
  it is" rule, and the disclosure. Push to the `docs` branch with the plumbing
  recipe.
- `README.md`: the assistant section, if it describes what the assistant can
  see.
- `brief()` doc comment: it is no longer "quote-light".

## Left to the builder

- Exact caps per rule and the tie-breaks inside them.
- Whether `excerpts()` takes one merged list with a `thread` field per message
  or a list of lists; whichever keeps `analyze()`'s existing call sites
  untouched.
- How the tapback loader is shared between `analyze()` and `excerpts()`.
- The person page's layout within the existing card styles.
- Test fixtures: a small synthetic `chat.db` is acceptable for the selection
  rules; the budget and timing are checked against a real library by hand.

## Builder-check questions, and the calls made

A reviewer planned from the draft and raised five questions. All were settled
without changing what gets built, and are folded into the sections above:

1. **Who can be a person.** Anyone who has sent a message; a cached people
   directory replaces the top-twelve table as the source. See Constraints.
2. **Per-thread rows.** A `personRow()` extracted from `analyze()` and called
   by it, not a full analysis per thread. See The person brief.
3. **Name or handle.** Handle as the key, name for selection, `person:<name>`
   for history. See Constraints.
4. **Thread floor and merges.** Floor of 10 messages from them per thread;
   remembered merges honoured; merge state in the cache key. See Constraints.
5. **Local providers.** Quarter budget and a disclosure when `cfg.local`.
   See The excerpt layer.

## Open questions resolved during design

- *Should the model get the full history, map-reduce style?* No. One request
  per ask, a chosen subset with the rule stated. Revisit if a local provider
  makes the cost irrelevant.
- *Should Everything read text too?* No; it points at the person view.
- *Is this roast-specific?* No. Roast is a tone.
