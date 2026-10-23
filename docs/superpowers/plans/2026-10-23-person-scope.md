# Person Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third assistant scope, *person*, that answers from a person's real messages across every conversation they are in, plus the same excerpt layer for the per-chat assistant.

**Architecture:** Pure selection and per-person statistics live in `analyze.mjs` (shared by the chat report and the person view); the person-specific data layer (directory, thread resolution, corpus) is a new `person.mjs`; `serve.mjs` adds the briefs, routes, caching and budgets; `ui/index.html` adds the person page, its ask target and the entry points. A `test/` directory with a synthetic `chat.db` fixture and `node --test` is introduced, since the repo has no tests today.

**Tech Stack:** Node 26 ESM, `node:sqlite`, `node:test` + `node:assert/strict`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-23-person-scope-design.md`

## Global Constraints

- Go through `lib.mjs`: `messageText()`, `DATE_TO_MICROS` + `appleMicrosToMs()`, `REAL_MESSAGE_WHERE`, `canonical()`, `day()`, `TZ`. Every date in a brief is local and says so.
- `message.date` is nanoseconds since 2001-01-01 and exceeds `MAX_SAFE_INTEGER`; the fixture binds it as a `BigInt`; queries divide in SQL.
- Tapbacks: 2000–2007 add, 3000–3007 remove; last state per (reactor, part-qualified guid) wins; target guid is the tail after `/`; count distinct reactors per message.
- A person is keyed by **canonical handle** in URLs, API and caches; their messages are selected by **display name** (`who`); history key is `person:<name>`.
- "Every conversation they are in" = chats with ≥ 1 message *from* them, folded by strict siblings (`findSiblingChats`) when `combine` is on **and** by `merges.local.json` entries; thread floor **10** messages from them; threads below the floor are counted, not loaded.
- Excerpt budgets: **40,000** chars (person), **20,000** chars (chat); × **0.25** when `cfg.local`. Line text truncated at **400** chars plus `…`. Search terms are question words of **≥ 4** characters after `words()` and the stop list, at most **8**, plus the typed term.
- Rule caps (builder may tune within reason): reacted 60, laughed-at 60, longest 4 per thread, repeated 10, unanswered 10, search 40 lines / 8,000 chars on top of the budget.
- Laugh window **5 minutes**; unanswered window **1 hour**, groups only; reacted rule groups only.
- `serve.mjs` is single-threaded: the person corpus is cached under `invalidate()` keyed `(handle, combine, digest of merges file)`.
- `markdown()` in the UI builds DOM nodes only; model output is never markup. Async renders capture `PAGE` and bail if it moved.
- Nothing identifying in `CLAUDE.local.md`; it is pushed to the public `docs` branch.
- Docs land in the same commit as the code they describe.

## Review Focus

1. **Person with no thread above the floor** (a number with three messages total): the person page renders the header and "no conversation has 10+ messages from them", the ask box is absent, nothing throws. Pinned in Task 8 (`personDetail`) and Task 10.
2. **Unknown or unnamed handle**: `/api/person?handle=…` for a handle nobody sent from returns 404 JSON; an unnamed number works with the raw handle as its name. Pinned in Task 6 and Task 9.
3. **Question with no searchable words** ("roast them"): no search layer, excerpts still fill the budget, no throw. Pinned in Task 5.
4. **A budget smaller than any one line** (local provider, tiny budget): the result never exceeds the budget, may be empty, never throws. Pinned in Task 5.
5. **Attachment-only messages** (text is only U+FFFC): never an excerpt candidate even if heavily reacted to. Pinned in Task 5.

---

### Task 1: Test harness and fixture database

**Files:**
- Create: `test/fixture.mjs`
- Create: `test/fixture.test.mjs`
- Modify: `.gitignore` (nothing needed unless temp files land in repo; fixture writes under `os.tmpdir()`)

**Interfaces:**
- Produces: `makeDb(spec) → { path, dir, db, namesPath }` and `sample() → spec` in `test/fixture.mjs`; `ns(iso) → BigInt` helper.
- `spec = { handles: {ROWID: id}, chats: [{id, ci, style, dn, ogid, roster:[handleRowid]}], messages: [{id, chat, from: handleRowid|"me", at: iso, text, amt?, target?: guid, item?: 0}], names: {canonicalHandle: name}, me: "+15550000000" }`. Message `guid` is `m<id>`. Tapbacks are messages with `amt` 2000–3007 and `target` = `p:0/m<id>`.
- Schema (minimum the code under test touches; add a nullable column rather than touching production queries if something is missing): `handle(ROWID, id)`, `chat(ROWID, guid, chat_identifier, display_name, style, original_group_id)`, `chat_handle_join(chat_id, handle_id)`, `message(ROWID, guid, text, attributedBody, date, is_from_me, handle_id, destination_caller_id, associated_message_type, associated_message_guid, associated_message_emoji, item_type, group_action_type, group_title, other_handle, date_read, date_delivered, thread_originator_guid, balloon_bundle_id, cache_has_attachments)`, `chat_message_join(chat_id, message_id)`, `attachment(ROWID, mime_type, uti, transfer_name, total_bytes, is_sticker)`, `message_attachment_join(message_id, attachment_id)`.
- `sample()` is the scenario every later test asserts against:
  - handles: 1 `+15550000001` (Ann), 2 `+15550000002` (Bob), 3 `+15550000003` (Cal). `names`: `{"15550000001":"Ann","15550000002":"Bob","15550000003":"Cal"}`. `me` = `+15550000000` (unnamed, so `resolveMe` yields "Me").
  - chats: 1 `{ci:"+15550000001", style:45, roster:[1]}`; 2 `{ci:"chat999", style:43, dn:"Crew", roster:[1,2]}`; 3 `{ci:"SMS;-;+15550000001", style:45, roster:[1]}` (strict sibling of 1 by identical roster); 4 `{ci:"chat888", style:43, dn:"Crew", roster:[1,3]}` (same name, different roster).
  - messages (chat, from, at, text):
    - m1 (1, Ann, 2023-01-10T10:00, "hey are you around?"), m2 (1, me, 10:01, "yes lol"), m3 (1, Ann, 10:02, "ok cool"), m4 (1, Ann, 10:03, "coming over"), m5 (1, Ann, 2024-03-05T22:00, "this is the longest message ann has ever written in this fixture, truly"), m6 (1, me, 2024-03-05T22:30, "haha")
    - m7 (3, Ann, 2022-06-01T09:00, "old sms thread")
    - m8 (2, Bob, 2023-05-01T12:00, "who's in"), m9 (2, Ann, 12:01, "me obviously"), m10 (2, Bob, 12:02, "lmao"), m11 (2, Ann, 2023-05-02T12:00, "coming over"), m12 (2, Ann, 2023-05-02T14:00, "anyone?"), m13 (2, Ann, 2023-05-03T09:00, "ok"), m14 (2, me, 2024-01-01T00:30, "happy new year")
    - m15 (4, Ann, 2023-06-01T10:00, "crew sms")
    - m16 (2, Ann, 2023-05-04T10:00, "￼") — attachment-only
    - tapbacks (chat 2): t1 Bob 2003 on `p:0/m9`; t2 me 2000 on `p:0/m9`; t3 Bob 2000 on `p:0/m11` then t4 Bob 3000 on `p:0/m11`; t5 Bob 2000 on `p:0/m16`; t6 me 2003 on `p:0/m16`.
  - All times are given in the machine's local zone (`new Date(y, mo, d, h, mi)`), never `Date.parse(iso)`; the `at` strings are a notation, the helper builds local dates.

- [ ] **Step 1: Write `test/fixture.mjs`** with `makeDb`, `sample`, `ns`. `makeDb` writes `chat.db` and `names.json` (shape `{names, aliases:{}}`) into a fresh `mkdtempSync` dir and returns an open `DatabaseSync` on the path plus the paths.

- [ ] **Step 2: Write the failing smoke test** `test/fixture.test.mjs`:

```js
test("fixture loads through lib and analyze", () => {
  const { db, namesPath } = makeDb(sample());
  const { names, canonical } = loadIdentities(namesPath, db);
  const { msgs } = loadMessages(db, [1], { names, canonical, meName: "Me" });
  assert.deepEqual(msgs.map((m) => m.who), ["Ann", "Me", "Ann", "Ann", "Ann", "Me"]);
  const resolved = resolveChats(db, { chatId: 1, merge: true, canonical });
  assert.deepEqual(resolved.ids, [1, 3]);
  const A = analyze(db, { ids: [1], msgs, byGuid: new Map(msgs.map((m) => [m.guid, m])), label: (h, me) => me ? "Me" : "Ann", chat: { id: 1, style: 45 }, names, canonical });
  assert.equal(A.total, 6);
});
```

- [ ] **Step 3: Run** `node --test test/` — expected: FAIL (module missing, then schema errors).

- [ ] **Step 4: Implement the fixture until the smoke test passes.** If `analyze()` throws "no such column", add that column (nullable) to the fixture schema; do not edit `analyze.mjs`.

- [ ] **Step 5: Run** `node --test test/` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/
git commit -m "Add a synthetic chat.db fixture and node --test harness"
```

---

### Task 2: `personStats()` — per-person rows from messages alone

**Files:**
- Modify: `analyze.mjs` (new export, placed before `analyze()`)
- Test: `test/person-stats.test.mjs`

**Interfaces:**
- Produces: `export function personStats(msgs, { gap = 6 * 3600_000, top = 10, minUses } = {}) → { rows: Map<who, Row>, wordsBy, totalWordsBy, firstUse, emojiAll }`
- `Row = { who, n, byYear: {[year]: n}, hours: number[24], peakHour, night, avgLen, medianLen, maxLen, starts, lastWord, medianReply, doubles, laughs, questions, vocab, topWords: [{word, n}], topEmoji: [{emoji, n}], signature: [{word, n, ratio}] }`
- Rules copied from `analyze()` so the swap in Task 3 is number-identical: starts = `i === 0 || m.ms - prev.ms >= gap`; lastWord = `!next || next.ms - m.ms >= gap`; doubles = `prev.who === m.who`; reply = `prev.who !== m.who && m.ms - prev.ms < gap`, `medianReply = median(replies)`; `night` = sum of hours 0–4; `LAUGH` and the question regex as in analyze's odds-and-ends pass; words via `words()` + `STOP`, `vocab` includes stop words; `minUses` default `Math.max(5, Math.round(msgs.length / 3000))`; signature = top 8 by ratio with `null` ratio (only them) sorting first, exactly as the existing block.
- `wordsBy`, `totalWordsBy`, `firstUse`, `emojiAll` are returned so `analyze()` can keep its "words they picked up" and overall-emoji passes without running `words()` twice.

- [ ] **Step 1: Write the failing tests** using `loadMessages` on fixture chat 1:

```js
test("personStats on the 1:1", () => {
  const { rows } = personStats(msgs, { gap: 6 * 3600_000 });
  const ann = rows.get("Ann"), me = rows.get("Me");
  assert.equal(ann.n, 4);
  assert.deepEqual(ann.byYear, { 2023: 3, 2024: 1 });
  assert.equal(ann.peakHour, 10);
  assert.equal(ann.doubles, 2);           // m4 after m3, m5 after m4 — the gap does not matter for doubles
  assert.equal(ann.medianReply, 60_000);  // m3 answers m2
  assert.equal(ann.starts, 2);            // m1, m5
  assert.equal(ann.lastWord, 1);          // m4
  assert.equal(ann.questions, 1);
  assert.equal(ann.laughs, 0);
  assert.equal(me.laughs, 2);             // "yes lol", "haha"
  assert.equal(ann.maxLen, [...msgs[4].text].length);
});
test("signature words respect minUses", () => {
  const { rows } = personStats(msgs, { minUses: 1 });
  assert.ok(rows.get("Ann").signature.some((w) => w.word === "coming"));
});
```

- [ ] **Step 2: Run** `node --test test/person-stats.test.mjs` — expected: FAIL, `personStats` is not exported.

- [ ] **Step 3: Implement `personStats` in `analyze.mjs`.** Keep `STOP`, `LAUGH`, `EMOJI_RE`, `words()` where they are; the function is three passes (calendar/length, adjacency, words+emoji) and the signature block.

- [ ] **Step 4: Run** the test — expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "Add personStats(): per-person rows computable from messages alone"`

---

### Task 3: `analyze()` delegates its per-person fields to `personStats()`

**Files:**
- Modify: `analyze.mjs:540-700` (per-person/per-year, hourByPerson, lens, starters/enders/doubles/replies), `analyze.mjs:1120-1176` (words, signature), `analyze.mjs:1199-1210` (laughs, questions), `analyze.mjs:1236-1270` (`perPerson` object)
- Test: `test/analyze-golden.test.mjs`

**Interfaces:**
- Consumes: `personStats()` from Task 2.
- Produces: unchanged `analyze()` output shape. `perPerson[i]` fields `byYear, peakHour, night, hours, avgLen, medianLen, maxLen, starts, lastWord, medianReply, doubles, laughs, questions, vocab, topWords, topEmoji` and `signature.people` now come from `personStats().rows`. `analyze()` keeps its own loop only for `fastest`, `replyTo`/`matrix` and `bestRun`.

- [ ] **Step 1: Write the golden test first, against the current code.** Run `analyze()` on fixture chats `[1]` and `[2]` (merge on), pick `perPerson` with the field list above plus `signature`, and write them to `test/golden/analyze-<chat>.json` with a tiny script run once (`node test/golden/write.mjs`). The test asserts `deepEqual` against the files.

- [ ] **Step 2: Run** `node --test test/analyze-golden.test.mjs` — expected: PASS (the golden is the current behaviour).

- [ ] **Step 3: By hand, snapshot a real chat:** `node stats.mjs --chat <ROWID> --merge > /tmp/before.txt` on this machine's library (pick the busiest group). Not committed.

- [ ] **Step 4: Refactor `analyze()`** to call `personStats(msgs, { gap, top })` once and read the listed fields from `rows`; delete the duplicated maps. Keep `shouts`, `links`, `domains`, `exact`, `emojiAll` and the picked-up-words pass (now fed from the returned `wordsBy/totalWordsBy/firstUse`).

- [ ] **Step 5: Run** `node --test test/` — expected: PASS, golden unchanged.

- [ ] **Step 6: Verify on the real library:** `node stats.mjs --chat <ROWID> --merge > /tmp/after.txt && diff /tmp/before.txt /tmp/after.txt` — expected: no output.

- [ ] **Step 7: Commit** `git commit -am "analyze() reads its per-person rows from personStats()"`

---

### Task 4: `loadReactions()` — the tapback state, extracted

**Files:**
- Modify: `analyze.mjs:764-824` (extract), new export above `analyze()`
- Test: `test/reactions.test.mjs`

**Interfaces:**
- Produces: `export function loadReactions(db, ids, { byGuid, label }) → { latest: Tap[], reactors: Map<guid, Set<who>>, laughReactors: Map<guid, Set<who>>, seen: number }` where `Tap = { self, guid, amt, who, emoji }` after removal resolution (no `amt >= 3000` entries), `seen` is the count of distinct tapback rows read (what `tapbacks.total` reports today), and `laughReactors` holds reactors whose kind is `TAPBACK_KINDS[amt] === "laughed"`.
- `analyze()` calls it and derives `given`, `received`, `kinds`, `kindsBy`, `customEmoji`, `perMsg` from `latest`/`reactors` as before.

- [ ] **Step 1: Write the failing test** on fixture chat 2:

```js
test("reactions resolve removals and count distinct reactors", () => {
  const r = loadReactions(db, [2], { byGuid, label });
  assert.equal(r.reactors.get("m9").size, 2);          // Bob laughed, Me loved
  assert.deepEqual([...r.laughReactors.get("m9")], ["Bob"]);
  assert.equal(r.reactors.has("m11"), false);           // loved then taken back
  assert.equal(r.seen, 6);
});
```

- [ ] **Step 2: Run** — expected: FAIL, not exported.
- [ ] **Step 3: Extract the block into `loadReactions`** and make `analyze()` use it. The golden test from Task 3 must still pass; `tapbacks.total`, `mostReacted`, `given/received` on `node stats.mjs` output must be unchanged (`diff` against `/tmp/after.txt`).
- [ ] **Step 4: Run** `node --test test/` — expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Extract loadReactions() from analyze()"`

---

### Task 5: `excerpts()` and `questionTerms()` — the selection layer

**Files:**
- Modify: `analyze.mjs` (two new exports)
- Test: `test/excerpts.test.mjs`

**Interfaces:**
- Produces:
  - `export function questionTerms(question) → string[]` — `words(question)` minus `STOP`, length ≥ 4, deduped, first 8.
  - `export function excerpts(msgs, opts) → { lines: Line[], counts: {[rule]: number}, budget, used, searchUsed }`
  - `opts = { who = null, reactions = null, budget = 20000, caps = {reacted:60, laughed:60, longest:4, repeated:10, unanswered:10, search:40}, searchCharCap = 8000, laughWindowMs = 300_000, unansweredMs = 3_600_000, terms = [] }`
  - `msgs` are `loadMessages` messages with two extra fields set by the caller: `thread` (string) and `isGroup` (boolean). One merged list, ordered by `ms`; adjacency rules (laughed-at, unanswered) only look at neighbours **within the same thread**.
  - `Line = { guid, thread, who, ms, text, why: string[], term?: string, before?: {who, ms, text}, after?: {who, ms, text} }` — `before`/`after` only on `reacted` and `laughed` lines.
  - Candidates: `who ? m.who === who : true`, and never text matching `/^[￼\s]*$/`.
  - Rules in order: `reacted` (groups only, by `reactions.reactors.get(guid).size` desc, laugh reactors break ties above), `laughed` (next message in the thread by someone else within the window matches `LAUGH`), `longest` (per thread), `repeated` (normalised exact text seen ≥ 2 times by the candidate; one line per distinct text, `text` prefixed with `(×N) `), `unanswered` (groups only), `spread` (stratify remaining candidates by `thread|year`, split the remaining budget evenly, take every k-th), then `search` (any term as a case-insensitive substring; newest first; its own cap and char cap on top of the budget). Dedupe by guid; a line picked twice carries both tags.
  - `used` counts `text.length` of every line (after truncation to 400 + `…`), plus context lines. `used ≤ budget` always; search lines count toward `searchUsed ≤ searchCharCap`.

- [ ] **Step 1: Write the failing tests** on the full fixture corpus (chats 1, 3, 2, 4 loaded separately, each message tagged with `thread`/`isGroup`, concatenated and sorted by `ms`; reactions from `loadReactions(db,[2],…)`):

```js
test("rules pick what the spec says", () => {
  const ex = excerpts(corpus, { who: "Ann", reactions, budget: 40000 });
  const by = (rule) => ex.lines.filter((l) => l.why.includes(rule)).map((l) => l.guid);
  assert.deepEqual(by("reacted"), ["m9"]);              // m11's reaction was removed, m16 is attachment-only
  assert.deepEqual(by("laughed").sort(), ["m1", "m9"]); // "yes lol" in 1 min, "lmao" in 1 min; "haha" 30 min later misses
  assert.ok(by("longest").includes("m5"));
  assert.ok(ex.lines.find((l) => l.why.includes("repeated") && l.text.startsWith("(×2) coming over")));
  assert.deepEqual(by("unanswered").sort(), ["m11", "m12", "m13"]); // each followed only by Ann herself, over an hour later
  assert.ok(ex.lines.every((l) => l.guid !== "m16"));
  assert.ok(ex.lines.find((l) => l.guid === "m9").before.who === "Bob");
  assert.ok(ex.counts.spread >= 1);
});
test("search terms come from the question", () => {
  assert.deepEqual(questionTerms("what did Ann say about coming over?"), ["coming"]); // "what", "about", "over" are stop words; "ann" is too short
  const ex = excerpts(corpus, { who: "Ann", budget: 0, terms: ["coming"] });
  assert.deepEqual(ex.lines.map((l) => l.guid).sort(), ["m11", "m4"]);
  assert.ok(ex.lines.every((l) => l.term === "coming"));
});
test("no terms and a tiny budget never throw", () => {
  assert.deepEqual(questionTerms("what about them?"), []);
  const ex = excerpts(corpus, { who: "Ann", budget: 5 });
  assert.equal(ex.lines.length, 0);
  assert.ok(ex.used <= 5);
});
test("budget is respected and long lines are cut", () => {
  const long = { ...corpus[0], guid: "x", text: "a".repeat(1000), who: "Ann" };
  const ex = excerpts([...corpus, long], { who: "Ann", budget: 450 });
  assert.ok(ex.used <= 450);
  assert.ok(ex.lines.every((l) => l.text.length <= 401));
});
```

- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement** `questionTerms` and `excerpts` in `analyze.mjs`.
- [ ] **Step 4: Run** `node --test test/` — expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Add excerpts(): rule-driven selection of real messages for the assistant"`

---

### Task 6: `peopleDirectory()` in `person.mjs`

**Files:**
- Create: `person.mjs`
- Test: `test/people.test.mjs`

**Interfaces:**
- Produces: `export function peopleDirectory(db, { names, canonical }) → Person[]`, `Person = { handle, name, n, chats: number[], first, last }` sorted by `n` desc. Built from one grouped query over `message` joined to `handle` and `chat_message_join` (`REAL_MESSAGE_WHERE`), grouped by `h.id, j.chat_id`, folded in JS by `canonical(normalizeHandle(h.id))`. Shortcodes excluded (`isShortcode`); outgoing rows excluded (no `handle_id`). Two canonical handles with the same resolved name fold into the busier handle (sum `n`, union `chats`). Dates via `DATE_TO_MICROS`/`appleMicrosToMs`.

- [ ] **Step 1: Write the failing test**

```js
test("directory lists senders by canonical handle", () => {
  const list = peopleDirectory(db, { names, canonical });
  assert.deepEqual(list.map((p) => [p.name, p.n]), [["Ann", 11], ["Bob", 2]]); // m16, the attachment-only row, is still a message
  assert.deepEqual([...list[0].chats].sort(), [1, 2, 3, 4]);
  assert.equal(list[0].handle, "15550000001");
});
test("an unnamed sender is listed under its handle", () => {
  const list = peopleDirectory(db, { names: new Map(), canonical });
  assert.equal(list[0].name, "+15550000001");
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Add person.mjs with peopleDirectory()"`

---

### Task 7: `personThreads()` — which conversations, folded, floored

**Files:**
- Modify: `person.mjs`
- Test: `test/person-threads.test.mjs`

**Interfaces:**
- Produces: `export function personThreads(db, { handle, canonical, names, merges = {}, combine = true, floor = 10 }) → { threads: Thread[], others: number }`, `Thread = { id, ids: number[], name, isGroup, n }` where `n` is messages from that handle across `ids`, sorted 1:1 first then by `n` desc; `others` = number of folded threads below the floor.
- Folding: start from `{chatId → n}` for the handle; if `combine`, union through `findSiblingChats(db, canonical)`; then for every `merges[key]` with `merge !== false`, union `[Number(key), ...ids]` into whichever group contains any of them (`dismissed` ids are never pulled in). Anchor `id` = member with the most total messages (`chatSummaries`), the sidebar's rule. `name` = anchor's `display_name`, else for a 1:1 the counterpart's name, else `(unnamed group)`; `isGroup` = anchor `style === 43`.

- [ ] **Step 1: Write the failing tests**

```js
test("folds strict siblings, applies the floor", () => {
  const r = personThreads(db, { handle: "15550000001", canonical, names, floor: 5 });
  assert.deepEqual(r.threads.map((t) => [t.id, t.ids, t.n, t.isGroup, t.name]),
    [[1, [1, 3], 5, false, "Ann"], [2, [2], 5, true, "Crew"]]);   // Ann sent 5 in Crew: m9, m11, m12, m13, m16
  assert.equal(r.others, 1);   // the other Crew, one message
});
test("floor 1 lists everything, 1:1 first", () => {
  const r = personThreads(db, { handle: "15550000001", canonical, names, floor: 1 });
  assert.deepEqual(r.threads.map((t) => t.id), [1, 2, 4]);
});
test("remembered merges fold same-name threads", () => {
  const r = personThreads(db, { handle: "15550000001", canonical, names, floor: 5, merges: { "2": { merge: true, ids: [4] } } });
  assert.deepEqual(r.threads.map((t) => [t.ids, t.n]), [[[1, 3], 5], [[2, 4], 6]]);
  assert.equal(r.others, 0);
});
test("combine off keeps siblings apart", () => {
  const r = personThreads(db, { handle: "15550000001", canonical, names, floor: 1, combine: false });
  assert.deepEqual(r.threads.map((t) => t.ids), [[1], [3], [2], [4]]);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -am "personThreads(): a person's conversations, folded and floored"`

---

### Task 8: `personCorpus()` and `personDetail()`

**Files:**
- Modify: `person.mjs`
- Test: `test/person-detail.test.mjs`

**Interfaces:**
- Consumes: `personThreads`, `loadMessages`, `resolveMe`, `loadReactions`, `personStats`.
- Produces:
  - `export function personCorpus(db, { handle, names, canonical, merges, combine, floor }) → { handle, name, aka: string[], threads: Thread[], others, msgs: Msg[], reactions: { reactors, laughReactors }, meName }` — loads each thread with `loadMessages`, tags every message with `thread` (Thread.name) and `isGroup`, concatenates sorted by `ms`; merges each thread's `loadReactions` maps into one pair keyed by guid. `name = names.get(handle) ?? handle`; `aka` = other raw handles that canonicalise to the same name (from the directory query), excluding the primary.
  - `export function personDetail(corpus, { gap, top = 8 }) → { person: { handle, name, aka, total, first, last, threadCount, others, tz: TZ }, threads: [{ id, ids, name, isGroup, n, total, share, first, last, row }] }` where `row` is `personStats(threadMsgs).rows.get(name)` with `topWords` and `signature` cut to `top`. `total` is the thread's message count, `share = n / total`. Pure: no db.

- [ ] **Step 1: Write the failing tests**

```js
test("corpus spans every thread above the floor", () => {
  const c = personCorpus(db, { handle: "15550000001", names, canonical, merges: {}, combine: true, floor: 1 });
  assert.equal(c.name, "Ann");
  assert.deepEqual([...new Set(c.msgs.map((m) => m.thread))].sort(), ["Ann", "Crew"]);
  assert.equal(c.msgs.filter((m) => m.who === "Ann").length, 11);
  assert.equal(c.reactions.reactors.get("m9").size, 2);
});
test("detail has one row per thread with the person's numbers", () => {
  const c = personCorpus(db, { handle: "15550000001", names, canonical, merges: {}, combine: true, floor: 1 });
  const d = personDetail(c, {});
  assert.equal(d.person.total, 11);
  const one = d.threads.find((t) => t.id === 1);
  assert.equal(one.n, 5); assert.equal(one.total, 7);
  assert.deepEqual(one.row.byYear, { 2022: 1, 2023: 3, 2024: 1 });
});
test("a person below the floor everywhere has no threads and does not throw", () => {
  const c = personCorpus(db, { handle: "15550000002", names, canonical, merges: {}, combine: true, floor: 10 });
  const d = personDetail(c, {});
  assert.deepEqual(d.threads, []); assert.equal(d.person.others, 1); assert.equal(d.person.total, 0);
});
```
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -am "personCorpus() and personDetail(): one person across every thread"`

---

### Task 9: Server — routes, briefs, budgets, scopes

**Files:**
- Modify: `serve.mjs` — imports (line 33–34), constants after `TONES` (line 492), `AI_RULES` (446), `AI_SCOPES` (470), `brief()` (531), new `renderExcerpts()` and `personBrief()` after `libraryBrief()` (~700), `aiAsk()` (794), `saveMerge()` (748: call `invalidate()` after writing), routes (1078 ask; add `/api/people`, `/api/person` next to `/api/overview` at 1094), `overview()`'s `shape()` in `analyze.mjs:~395` (add `handle`).
- Create: `test/llm-stub.mjs` (an OpenAI-wire stub: `POST /v1/chat/completions` returns `{choices:[{message:{content:"STUB:" + <first 200 chars of user message>}, finish_reason:"stop"}]}` and records the last request body to a file given on argv; `GET /v1/models` returns `{data:[{id:"stub"}]}`).
- Test: `test/server.test.mjs` — spawns `node serve.mjs --port <free> --db <fixture> --names <fixture names>` with `MESSAGESTATS_DATA=<tmpdir>` containing `ai.local.json` = `{"provider":"custom","baseUrl":"http://127.0.0.1:<stub>/v1","model":"stub","apiKey":"x"}`; waits on `/api/ping`; kills both on exit.

**Interfaces:**
- `const EXCERPT_BUDGET = { chat: 20_000, person: 40_000 }; const LOCAL_BUDGET_SCALE = 0.25;`
- `renderExcerpts(ex, { subject }) → string` — preamble: `EXCERPTS — <N> real messages <by subject | from this conversation>, chosen by rule, not a sample of everything: <rule: count, …>. Dates local (<TZ>). This is a subset; anything not quoted here is unknown to you.` Then lines `YYYY-MM-DD · <thread> · <who>: <text>` grouped under the rule headings in rule order, `before`/`after` indented two spaces as `↳ <who>: <text>`, search hits last under `SEARCH "<term>"`.
- `brief(A, { search, excerpts })` appends `renderExcerpts(excerpts, { subject: null })` after the existing quoted lines; doc comment updated (no longer "quote-light").
- `personBrief(D, ex) → string`: header (name, aka, total, span, `threadCount` + `others`, TZ line), `PER THREAD` lines in the format of `brief()`'s per-person line prefixed with the thread name and `share`, then `renderExcerpts(ex, { subject: D.person.name })`, then `WHAT IS NOT HERE: other people's numbers in these threads, the full text of anything, and threads where <name> sent fewer than 10 messages (<others> of them).`
- `AI_SCOPES.person` (exact copy): `You are analysing one person across every iMessage conversation they share with the owner — their one-to-one thread and each group. The context has their per-conversation numbers and a chosen subset of their real messages, with the selection rules stated. Quote only text that appears in the context, verbatim. Anything not in the context is unknown: say "the excerpts" rather than "their messages" when generalising.`
- `AI_RULES` first sentence becomes: `You are given computed statistics plus a chosen subset of real messages — so ground every claim in the numbers and the quoted lines you were given, quote only verbatim, and never invent a quote, a name, or a figure.`
- `aiAsk({ scope: "person", handle, combine, question, searchFor, tone })`: `corpus = personCorpusCached(handle, combine)` keyed `person|${handle}|${combine}|${mergesDigest()}` (sha1 of the merges file text, `""` if absent); `D = personDetail(corpus)`; `ex = excerpts(corpus.msgs, { who: corpus.name, reactions, budget, terms: [...questionTerms(question), ...(searchFor ? [searchFor] : [])] })`; `budget = EXCERPT_BUDGET.person * (cfg.local ? LOCAL_BUDGET_SCALE : 1)`; `key = "person:" + corpus.name`; `subject = corpus.name`; `out.excerptChars = ex.used + ex.searchUsed`. If `D.threads.length === 0` throw `Error("<name> has fewer than 10 messages in every conversation — nothing to read.")`.
- Chat branch: after `chatDetail`, `loadMessages` + `loadReactions` for `resolved.ids`, tag `thread = A.chat.name`, `isGroup = A.chat.isGroup`, `excerpts(msgs, { reactions, budget: EXCERPT_BUDGET.chat * scale, terms })`, pass as `{ search, excerpts }` to `brief()`; `out.excerptChars` likewise.
- Routes: `GET /api/people` → cached `peopleDirectory`; `GET /api/person?handle=&combine=` → `personDetail(personCorpusCached(...))` or `404 {error:"no messages from that handle"}` when the directory has no such handle; `/api/ai/ask` accepts `scope: "person"` and `handle: String(q.handle ?? "")`.
- `overview()`'s `shape()` adds `handle: p.handle`.

- [ ] **Step 1: Write the failing server tests**

```js
test("people and person endpoints", async () => {
  const people = await get("/api/people");
  assert.equal(people[0].name, "Ann");
  const d = await get("/api/person?handle=15550000001");
  assert.equal(d.person.total, 11);
  assert.equal((await getRaw("/api/person?handle=19999999999")).status, 404);
});
test("person ask sends excerpts and the scope line", async () => {
  const r = await post("/api/ai/ask", { scope: "person", handle: "15550000001", question: "what did Ann say about coming over" });
  assert.equal(r.chatId, "person:Ann");
  assert.ok(r.excerptChars > 0);
  const sent = JSON.parse(readFileSync(STUB_LOG, "utf8"));
  const user = sent.messages.find((m) => m.role === "user").content;
  assert.match(user, /EXCERPTS — \d+ real messages by Ann/);
  assert.match(user, /SEARCH "coming"/);
  assert.match(user, /coming over/);
  assert.match(sent.messages[0].content, /one person across every iMessage conversation/);
});
test("chat ask now carries excerpts too", async () => {
  const r = await post("/api/ai/ask", { chatId: 2, merge: true, question: "roast them" });
  assert.ok(r.excerptChars > 0);
  const user = JSON.parse(readFileSync(STUB_LOG, "utf8")).messages.find((m) => m.role === "user").content;
  assert.match(user, /EXCERPTS — \d+ real messages from this conversation/);
  assert.match(user, /me obviously/);
});
test("a person below the floor everywhere is refused with a message", async () => {
  const r = await post("/api/ai/ask", { scope: "person", handle: "15550000002", question: "hi" });
  assert.match(r.error, /fewer than 10 messages/);
});
```
No fixture thread has 10 messages from Ann, so these tests need the floor lowered: have `personCorpusCached` read `floor` from `process.env.MESSAGESTATS_PERSON_FLOOR` when set (test sets it to `1`); default stays 10.

- [ ] **Step 2: Run** `node --test test/server.test.mjs` — FAIL (404s, errors).
- [ ] **Step 3: Implement** everything in the Interfaces block.
- [ ] **Step 4: Run** `node --test test/` — PASS.
- [ ] **Step 5: Time it on the real library.** With the app's data dir, `curl -s 'http://127.0.0.1:4173/api/person?handle=<a busy person>' -o /dev/null -w '%{time_total}\n'` twice; expected: first call a few seconds, second well under one.
- [ ] **Step 6: Commit** `git commit -am "Person scope on the server: directory, person endpoint, excerpt briefs for chat and person asks"`

---

### Task 10: UI — person page, ask target, entry points, disclosure

**Files:**
- Modify: `ui/index.html` — `SUGGESTED_PERSON` beside `SUGGESTED_LIBRARY` (1170); `markAsking` (1271); `askPanel` disclosure line (1444–1447) and the answer footer (1375); `chatAsk`/`libraryAsk` (1476–1495) plus new `personAsk`; Everything people table (2009–2017); `refreshChats` (603–606); routing (2112–2131); new `renderPerson(handle, gen)` near `renderOverview` (1967).

**Interfaces:**
- `personAsk(D) → { key: "person:" + D.person.name, placeholder: "Ask anything about " + D.person.name + " across every conversation…", suggestions: SUGGESTED_PERSON, search: true, sends: "messages", body: (question, searchFor) => ({ scope: "person", handle: D.person.handle, combine: PREFS.get("combineThreads"), question, search: searchFor }) }`
- `chatAsk` gains `sends: "messages"`; `libraryAsk` gains `sends: "totals"`.
- Disclosure line in `askPanel`: local → `Running on ${cfg.label} — nothing leaves this machine.` plus, when `sends === "messages"`, ` A smaller selection of messages is read, because a local model's context is short.`; remote and `sends === "messages"` → `Using ${cfg.label} (${cfg.model}). A selection of actual messages plus statistics is sent to the provider; every request is logged to ai-sent.local.jsonl so you can check what left.`; remote and `sends === "totals"` → the existing text.
- Answer footer: `sent N chars, M of them message text` using `r.contextChars` and `r.excerptChars ?? 0`.
- `SUGGESTED_PERSON` (exact): `["How are they different in the group chats versus one-on-one?", "What do they bring up unprompted, again and again?", "Write their introduction for a toast, from the excerpts only.", "How has the way they write changed over the years?", "Which of these messages would they least like read aloud?"]`
- `renderPerson(handle, gen = newPage())`: `const D = await api("/api/person?handle=…&combine=…")`; bail if `gen !== PAGE`; `#main` gets `h1` name, `p.sub` with total · threadCount conversations · span · `others` line when > 0; a card "Conversations" with a table (conversation, their messages, share, by year, first, latest; row click → `openChat(t.id)`); then `askPanel(personAsk(D))` only when `D.threads.length > 0`, otherwise a `p.muted` saying no conversation has 10+ messages from them. Error → `flag warn`.
- Routing: `hashchange` and initial load handle `#person=<encodeURIComponent(handle)>` → `renderPerson`. The Everything people row click sets `location.hash = "person=" + encodeURIComponent(p.handle)`; `#ovbtn` click clears the hash (already does).
- `markAsking`: keys starting with `person:` target `#ovbtn`.
- Sidebar: `PEOPLE` loaded lazily on first non-empty filter input via `/api/people`; `renderChats` is passed up to 3 people whose `name` includes the query (case-insensitive) and prints them first as `.chat` buttons labelled `Ask about <name>` with `data-id="person:<name>"`, click → set the person hash.

- [ ] **Step 1: Implement** the above.
- [ ] **Step 2: Verify in the browser** with the fixture (`MESSAGESTATS_PERSON_FLOOR=1 MESSAGESTATS_DATA=<tmp> node serve.mjs --db <fixture> --names <fixture names> --port 4199` and the stub from Task 9 in `ai.local.json`):
  - Everything → click Ann → person page lists Ann (1:1) and Crew; back button returns to Everything; reload on `#person=…` re-renders the person page.
  - Ask "what did Ann say about coming over" → answer begins `STUB:`; footer says `… of them message text`; sidebar dot on Everything while pending; opening a chat and coming back adopts the running ask.
  - Filter box: type "an" → "Ask about Ann" appears first.
  - Bob's page shows the no-threads message and no ask box.
  - Open a chat ask: disclosure line mentions actual messages.
- [ ] **Step 3: Commit** `git commit -am "Person view in the UI: page, ask target, Everything and sidebar entry points, disclosure"`

---

### Task 11: Documentation and release

**Files:**
- Modify: `CLAUDE.local.md` (new subsection after "The assistant on ✨ Everything"), `README.md:137-170`, `CLAUDE.md` (add `node --test test/` to the command block and one line on the person scope), `ai.example.json` `_quality_note` (~6KB → "up to ~40 KB for a person ask").

- [ ] **Step 1: `CLAUDE.local.md`** — add "### The assistant reads messages now: three scopes and the excerpt layer" covering: why not a dump; the seven rules and their caps; budgets and the local quarter; that the brief states its own selection; `person:<name>` keys and why name not handle; the floor and why; merges digest in the cache key; `personStats()` being the one place per-person numbers come from; the `MESSAGESTATS_PERSON_FLOOR` test hook; the stub-provider test recipe; that `shape()` now exposes `handle`. Nothing identifying.
- [ ] **Step 2: `README.md`** — rewrite the assistant paragraph: it gets statistics **plus a rule-chosen selection of real messages** (chat ~20 KB, person ~40 KB), and the person view; Everything unchanged.
- [ ] **Step 3: `CLAUDE.md`** — commands block and a one-line pointer.
- [ ] **Step 4: Run** `node --test test/` — PASS. **Step 5: Commit** `git commit -am "Document the person scope and the excerpt layer"`.
- [ ] **Step 6: Push** `git push origin main`, then push `CLAUDE.local.md` to the `docs` branch with the plumbing recipe at the bottom of that file (explicit `FILES=(CLAUDE.local.md ROADMAP.local.md)`, braces on `${COMMIT}`).
- [ ] **Step 7: Commit the spec and this plan** if not already on `main` (`git add docs/superpowers && git commit -m "Spec and plan for the person scope"` and push).
