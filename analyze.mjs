/**
 * The analysis itself, with no printing in it.
 *
 * `stats.mjs` renders this to a terminal; `serve.mjs` hands it to a browser as
 * JSON. Both call the same function, so the two front ends cannot drift into
 * disagreeing about what the numbers are — which is the whole reason this file
 * exists rather than the server re-deriving anything.
 *
 * Everything returned is plain JSON-safe data: numbers, strings, arrays and
 * object literals. No Maps, no Dates, no functions. Raw values only — no
 * padding, no percent signs, no "3d 4h" — formatting belongs to the caller.
 */

import {
  appleMicrosToMs, chatRosters, chatSummaries, DATE_TO_MICROS, day,
  findSameNameChats, findSiblingChats, messageText, median, normalizeHandle,
  REAL_MESSAGE_WHERE,
} from "./lib.mjs";

export const TAPBACK_KINDS = {
  2000: "loved", 2001: "liked", 2002: "disliked",
  2003: "laughed at", 2004: "emphasized", 2005: "questioned",
  2006: "emoji", 2007: "sticker",
};

const STOP = new Set(
  ("a about after all also am an and any are as at back be because been before but by can cant come " +
   "could did didnt do does doesnt doing dont down even for from get gets getting go going good got " +
   "gotta had has have having he her here hers hes him his how i id if ill im in into is isnt it its " +
   "ive just kinda know like ll lot make many maybe me mean more most much my need no not now of off " +
   "oh ok okay on one only or other our out over pretty probably really right said say says see she " +
   "should so some still such sure take than that thats the their them then there theres these they " +
   "theyre thing think this those thought through to too two up us ve very want was wasnt watch way " +
   "we well were what when where which who why will with would ya yea yeah yep yes yet you youre your " +
   "u ur im gonna wanna went being im dont doesnt wasnt arent couldnt wouldnt shouldnt let lets").split(/\s+/)
);

const EMOJI_RE = /(\p{Extended_Pictographic}(\p{Emoji_Modifier}|️)?(‍\p{Extended_Pictographic}(\p{Emoji_Modifier}|️)?)*)/gu;
const LAUGH = /(\blol\b|\blmao\b|\blmfao\b|\bhaha+\b|\bhehe+\b|\bheh\b|😂|🤣|💀)/i;

const inc = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const topN = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const obj = (map) => Object.fromEntries(map);

/**
 * Work out which chat rows to read before reading any of them.
 *
 * Returns the ids to query plus everything the caller needs to warn about what
 * is being left out. Cheap — metadata only, no message text.
 */
export function resolveChats(db, { chatId, merge = false, mergeIds = [], canonical }) {
  const chat = db
    .prepare(`select ROWID id, display_name, chat_identifier, style from chat where ROWID = ?`)
    .get(chatId);
  if (!chat) return null;

  const siblingIds = (findSiblingChats(db, canonical).get(chatId) ?? []).filter((id) => id !== chatId);
  const namedIds = (findSameNameChats(db, canonical).get(chatId) ?? [])
    .filter((id) => id !== chatId && !siblingIds.includes(id));

  const explicitIds = mergeIds.filter((id) => id !== chatId);
  const stats = chatSummaries(db, [...siblingIds, ...namedIds, ...explicitIds]);
  const has = (id) => (stats.get(id)?.n ?? 0) > 0;

  const siblings = siblingIds.filter(has);
  const named = namedIds.filter(has);
  const explicit = explicitIds.filter(has);
  const ids = mergeIds.length ? [chatId, ...explicit] : merge ? [chatId, ...siblings] : [chatId];

  const summary = (id) => {
    const s = stats.get(id);
    return {
      id, n: s?.n ?? 0,
      first: s?.first_us ? appleMicrosToMs(s.first_us) : null,
      last: s?.last_us ? appleMicrosToMs(s.last_us) : null,
    };
  };
  return {
    chat, ids,
    siblings: siblings.map(summary),
    named: named.map(summary),
    ignored: mergeIds.filter((id) => id !== chatId && !has(id)),
  };
}

/** Every message in these chats, deduped, oldest first. */
export function loadMessages(db, ids, { names, canonical, meName = "Me" }) {
  const holes = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `select m.guid guid, m.text text, m.attributedBody body,
              ${DATE_TO_MICROS.replace("date", "m.date")} us,
              m.is_from_me fromMe, h.id handle
         from message m
         join chat_message_join j on j.message_id = m.ROWID
         left join handle h on h.ROWID = m.handle_id
        where j.chat_id in (${holes}) and ${REAL_MESSAGE_WHERE}
        order by m.date asc`
    )
    .all(...ids);

  const label = (handle, isFromMe) =>
    isFromMe ? meName : names.get(canonical(normalizeHandle(handle ?? ""))) ?? handle ?? "Unknown";

  const msgs = [];
  const byGuid = new Map();
  for (const r of rows) {
    // chat_message_join can link one message to several chats; guid is unique.
    if (byGuid.has(r.guid)) continue;
    const text = messageText(r.text, r.body);
    const ms = appleMicrosToMs(r.us);
    if (!text || !text.trim() || !ms) continue;
    const m = { guid: r.guid, who: label(r.handle, r.fromMe === 1), ms, text, len: [...text].length };
    msgs.push(m);
    byGuid.set(r.guid, m);
  }
  return { msgs, byGuid, label };
}

/** Who "me" is, from destination_caller_id on your own outgoing messages. */
export function resolveMe(db, ids, { names, canonical }) {
  const holes = ids.map(() => "?").join(",");
  const row = db
    .prepare(
      `select m.destination_caller_id caller from message m
         join chat_message_join j on j.message_id = m.ROWID
        where j.chat_id in (${holes}) and m.is_from_me = 1
          and m.destination_caller_id is not null
        limit 1`
    )
    .get(...ids);
  return names.get(canonical(normalizeHandle(row?.caller ?? ""))) ?? "Me";
}

/**
 * The whole report as data.
 *
 * `msgs` must already be deduped and sorted (see loadMessages). `gap` is the
 * silence that ends a conversation, for start/last-word/reply accounting.
 */
export function analyze(db, { ids, msgs, byGuid, label, chat, top = 10, gap = 6 * 3600_000, names, canonical }) {
  const people = [...new Set(msgs.map((m) => m.who))];
  const total = msgs.length;
  const first = msgs[0];
  const last = msgs[msgs.length - 1];
  // Inclusive of both ends: Mon..Wed is 3 days. Without the +1 "days with any"
  // can exceed 100%.
  const spanDays = Math.floor((last.ms - first.ms) / 86_400_000) + 1;

  /* ---- per person, per year ---- */
  const per = new Map(), perYear = new Map();
  for (const m of msgs) {
    inc(per, m.who);
    const y = new Date(m.ms).getFullYear();
    if (!perYear.has(m.who)) perYear.set(m.who, new Map());
    inc(perYear.get(m.who), y);
  }
  const years = [...new Set(msgs.map((m) => new Date(m.ms).getFullYear()))].sort();
  const ranked = topN(per, 99);

  /* ---- calendar + clock ---- */
  const byDay = new Map(), byWeek = new Map(), byMonth = new Map();
  const byHourStamp = new Map(), byDow = new Map();
  const hourTotals = new Array(24).fill(0);
  const hourByPerson = new Map();
  for (const m of msgs) {
    const d = new Date(m.ms);
    inc(byDay, day(m.ms));
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    inc(byWeek, day(monday.getTime()));
    inc(byMonth, day(m.ms).slice(0, 7));
    inc(byHourStamp, `${day(m.ms)} ${String(d.getHours()).padStart(2, "0")}:00`);
    inc(byDow, d.getDay());
    hourTotals[d.getHours()] += 1;
    if (!hourByPerson.has(m.who)) hourByPerson.set(m.who, new Array(24).fill(0));
    hourByPerson.get(m.who)[d.getHours()] += 1;
  }

  const days = [...byDay.keys()].sort();
  let streak = 1, bestStreak = 1, streakEnd = days[0];
  for (let i = 1; i < days.length; i += 1) {
    if (Date.parse(days[i]) - Date.parse(days[i - 1]) === 86_400_000) {
      streak += 1;
      if (streak > bestStreak) { bestStreak = streak; streakEnd = days[i]; }
    } else streak = 1;
  }

  let maxGap = 0, gapAt = null;
  for (let i = 1; i < msgs.length; i += 1) {
    const g = msgs[i].ms - msgs[i - 1].ms;
    if (g > maxGap) { maxGap = g; gapAt = i - 1; }
  }

  const one = (map) => { const t = topN(map, 1)[0]; return t ? { key: t[0], n: t[1] } : null; };

  /* ---- length ---- */
  const lens = new Map();
  for (const m of msgs) {
    if (!lens.has(m.who)) lens.set(m.who, []);
    lens.get(m.who).push(m.len);
  }
  let longest = msgs[0];
  for (const m of msgs) if (m.len > longest.len) longest = m;

  /* ---- dynamics ---- */
  const starters = new Map(), enders = new Map(), doubles = new Map();
  const replies = new Map(), replyTo = new Map();
  let fastest = null;
  let run = { who: msgs[0].who, n: 1, at: msgs[0].ms };
  let bestRun = { ...run };
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i], prev = msgs[i - 1], next = msgs[i + 1];
    if (i === 0 || m.ms - prev.ms >= gap) inc(starters, m.who);
    if (!next || next.ms - m.ms >= gap) inc(enders, m.who);
    if (i > 0) {
      if (prev.who === m.who) { inc(doubles, m.who); run.n += 1; }
      else {
        if (run.n > bestRun.n) bestRun = { ...run };
        run = { who: m.who, n: 1, at: m.ms };
        if (m.ms - prev.ms < gap) {
          const dt = m.ms - prev.ms;
          if (!replies.has(m.who)) replies.set(m.who, []);
          replies.get(m.who).push(dt);
          const key = `${m.who}>${prev.who}`;
          if (!replyTo.has(key)) replyTo.set(key, []);
          replyTo.get(key).push(dt);
          if (dt > 0 && (!fastest || dt < fastest.dt)) fastest = { dt, m, prev };
        }
      }
    }
  }
  if (run.n > bestRun.n) bestRun = { ...run };

  const matrix = people.map((a) => ({
    who: a,
    to: Object.fromEntries(people.map((b) => {
      const xs = a === b ? null : replyTo.get(`${a}>${b}`);
      return [b, xs && xs.length >= 5 ? median(xs) : null];
    })),
  }));

  /* ---- tapbacks ---- */
  const holes = ids.map(() => "?").join(",");
  const taps = db
    .prepare(
      `select m.guid self, m.associated_message_guid guid,
              m.associated_message_type amt, m.is_from_me fromMe, h.id handle
         from message m
         join chat_message_join j on j.message_id = m.ROWID
         left join handle h on h.ROWID = m.handle_id
        where j.chat_id in (${holes})
          and m.associated_message_type between 2000 and 2007`
    )
    .all(...ids);

  const given = new Map(), received = new Map(), perMsg = new Map(), kinds = new Map();
  const seenTaps = new Set();
  for (const t of taps) {
    if (seenTaps.has(t.self)) continue;
    seenTaps.add(t.self);
    inc(given, label(t.handle, t.fromMe === 1));
    inc(kinds, TAPBACK_KINDS[t.amt] ?? String(t.amt));
    // associated_message_guid is prefixed, e.g. "p:0/<guid>" — take the tail
    const target = t.guid?.includes("/") ? t.guid.split("/").pop() : t.guid ?? "";
    const hit = byGuid.get(target);
    if (hit) { inc(received, hit.who); inc(perMsg, target); }
  }

  /* ---- words + emoji ---- */
  const wordsBy = new Map(), totalWordsBy = new Map();
  const emojiBy = new Map(), emojiAll = new Map();
  for (const m of msgs) {
    if (!wordsBy.has(m.who)) { wordsBy.set(m.who, new Map()); emojiBy.set(m.who, new Map()); totalWordsBy.set(m.who, 0); }
    for (const raw of m.text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) {
      const w = raw.replace(/^'+|'+$/g, "");
      if (w.length < 3 || STOP.has(w)) continue;
      inc(wordsBy.get(m.who), w);
      totalWordsBy.set(m.who, totalWordsBy.get(m.who) + 1);
    }
    for (const e of m.text.match(EMOJI_RE) ?? []) { inc(emojiBy.get(m.who), e); inc(emojiAll, e); }
  }

  /**
   * SIGNATURE WORDS. Not "what does this person say most" — everyone says the
   * same top words — but "what do they say far more than everyone else". Rate
   * within their own output over the same rate across everyone else, with a
   * floor on raw count so a word used twice can't top the chart.
   */
  const minUses = Math.max(5, Math.round(total / 3000));
  const signature = ranked.map(([who]) => {
    const mine = wordsBy.get(who), myTotal = totalWordsBy.get(who) || 1;
    const scored = [];
    for (const [w, n] of mine) {
      if (n < minUses) continue;
      let othersN = 0, othersTotal = 0;
      for (const [other, map] of wordsBy) {
        if (other === who) continue;
        othersN += map.get(w) ?? 0;
        othersTotal += totalWordsBy.get(other) ?? 0;
      }
      const otherRate = othersTotal ? othersN / othersTotal : 0;
      // otherRate 0 means nobody else has ever used it — more interesting than
      // any ratio, so it's flagged (null) rather than scored.
      scored.push({ word: w, n, ratio: otherRate ? (n / myTotal) / otherRate : null });
    }
    scored.sort((a, b) => (b.ratio ?? Infinity) - (a.ratio ?? Infinity));
    return { who, words: scored.slice(0, 8) };
  }).filter((s) => s.words.length);

  /* ---- odds and ends ---- */
  const laughs = new Map(), questions = new Map(), shouts = new Map();
  const links = new Map(), domains = new Map(), vocab = new Map(), exact = new Map();
  for (const m of msgs) {
    if (LAUGH.test(m.text)) inc(laughs, m.who);
    // Anywhere, not just the last character — "wait what? lol" is a question.
    // URLs stripped first because query strings are full of question marks.
    if (/\?/.test(m.text.replace(/https?:\/\/[^\s]+/g, ""))) inc(questions, m.who);
    const caps = m.text.match(/\b[A-Z]{3,}\b/g) ?? [];
    if (caps.length) inc(shouts, m.who, caps.length);
    for (const url of m.text.match(/https?:\/\/[^\s]+/g) ?? []) {
      inc(links, m.who);
      try { inc(domains, new URL(url).hostname.replace(/^www\./, "")); } catch { /* ignore */ }
    }
    if (!vocab.has(m.who)) vocab.set(m.who, new Set());
    for (const w of m.text.toLowerCase().match(/[\p{L}']{3,}/gu) ?? []) vocab.get(m.who).add(w);
    const key = m.text.trim().toLowerCase();
    if (key.length >= 2 && key.length <= 40) inc(exact, key);
  }

  const msgRef = (m) => m && { who: m.who, ms: m.ms, text: m.text, len: m.len, guid: m.guid };

  return {
    chat: {
      id: chat.id,
      name: chat.display_name?.trim() || chat.chat_identifier || `chat ${chat.id}`,
      isGroup: chat.style === 43,
      ids,
    },
    people, total, spanDays,
    first: first.ms, last: last.ms,
    perDay: total / spanDays,
    years,
    perPerson: ranked.map(([who, n]) => ({
      who, n, share: n / total,
      byYear: Object.fromEntries(years.map((y) => [y, perYear.get(who)?.get(y) ?? 0])),
      peakHour: hourByPerson.get(who).indexOf(Math.max(...hourByPerson.get(who))),
      night: hourByPerson.get(who).slice(0, 5).reduce((a, b) => a + b, 0),
      hours: hourByPerson.get(who),
      avgLen: lens.get(who).reduce((a, b) => a + b, 0) / lens.get(who).length,
      medianLen: median(lens.get(who)),
      maxLen: Math.max(...lens.get(who)),
      starts: starters.get(who) ?? 0,
      lastWord: enders.get(who) ?? 0,
      medianReply: median(replies.get(who) ?? []),
      doubles: doubles.get(who) ?? 0,
      given: given.get(who) ?? 0,
      received: received.get(who) ?? 0,
      laughs: laughs.get(who) ?? 0,
      questions: questions.get(who) ?? 0,
      shouts: shouts.get(who) ?? 0,
      links: links.get(who) ?? 0,
      vocab: vocab.get(who)?.size ?? 0,
      topWords: topN(wordsBy.get(who), top).map(([word, n]) => ({ word, n })),
      topEmoji: topN(emojiBy.get(who), 8).map(([emoji, n]) => ({ emoji, n })),
    })),
    busiest: {
      day: one(byDay), week: one(byWeek), month: one(byMonth), hour: one(byHourStamp),
      streak: {
        days: bestStreak, end: streakEnd,
        start: day(Date.parse(streakEnd) - (bestStreak - 1) * 86_400_000),
      },
      activeDays: byDay.size,
      silence: gapAt == null ? null : { ms: maxGap, after: msgRef(msgs[gapAt]) },
    },
    rhythm: {
      hours: hourTotals,
      dow: Array.from({ length: 7 }, (_, d) => byDow.get(d) ?? 0),
      byMonth: obj(byMonth), byDay: obj(byDay),
    },
    longest: msgRef(longest),
    dynamics: {
      gapHours: gap / 3600_000,
      monologue: { who: bestRun.who, n: bestRun.n, at: bestRun.at },
      fastest: fastest && { ms: fastest.dt, reply: msgRef(fastest.m), to: msgRef(fastest.prev) },
      matrix,
    },
    tapbacks: seenTaps.size === 0 ? null : {
      total: seenTaps.size,
      kinds: topN(kinds, 9).map(([kind, n]) => ({ kind, n })),
      mostReacted: topN(perMsg, 8)
        .map(([g, n]) => ({ n, msg: msgRef(byGuid.get(g)) }))
        .filter((x) => x.msg),
    },
    signature: { minUses, people: signature },
    emoji: { overall: topN(emojiAll, 14).map(([emoji, n]) => ({ emoji, n })) },
    odds: {
      domains: topN(domains, 8).map(([domain, n]) => ({ domain, n })),
      repeated: topN(exact, 8).map(([text, n]) => ({ text, n })),
      firstMsg: msgRef(first),
      lastMsg: msgRef(last),
    },
  };
}
