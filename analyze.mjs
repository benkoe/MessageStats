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
  findSameNameChats, findSiblingChats, isShortcode, messageText, median,
  normalizeHandle, REAL_MESSAGE_WHERE,
} from "./lib.mjs";
import { readArchive } from "./bplist.mjs";

export const TAPBACK_KINDS = {
  2000: "loved", 2001: "liked", 2002: "disliked",
  2003: "laughed at", 2004: "emphasized", 2005: "questioned",
  2006: "emoji", 2007: "sticker",
};

/**
 * The glyph iMessage actually shows for each one, so the breakdown can be read
 * at a glance instead of parsed as a sentence. Kept beside the names rather
 * than in the UI because `stats.mjs` prints them too.
 *
 * 2006 and 2007 are the newer any-emoji and sticker reactions, which have no
 * fixed glyph — they get a stand-in and their name.
 */
export const TAPBACK_ICONS = {
  "loved": "❤️", "liked": "👍", "disliked": "👎",
  "laughed at": "😂", "emphasized": "‼️", "questioned": "❓",
  "emoji": "🙂", "sticker": "🩹",
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
   "u ur im gonna wanna went being im dont doesnt wasnt arent couldnt wouldnt shouldnt let lets " +
   // The tokenizer strips edge apostrophes, so "wasn't" arrives as "wasn" and
   // never matches "wasnt" above. Without these the contraction stumps rank as
   // real vocabulary — "wasn" was showing up as a word someone picked up.
   "wasn isn aren doesn didn couldn wouldn shouldn don hasn haven hadn won ain weren mustn " +
   "ll re ve").split(/\s+/)
);

/**
 * URLs are not vocabulary, and they dominate the word counts if you let them.
 *
 * A pasted link contributes its scheme, its host and every path and query
 * segment as separate "words": `https` was the single most-used token in one
 * chat (1,658), followed by `youtu`, `www` and `utm`. Worse are the opaque
 * ids — `igsh`, `igshid` and Instagram's share tokens made a run of random
 * strings look like somebody's signature vocabulary.
 *
 * Bare domains count too: `instagram.com/reel/x` has no scheme, so matching
 * only `https?://` leaves `com` and the whole path behind.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|co|gg|tv|me|ly|app|dev|news|uk|edu|gov)\b\S*/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/gi;

/**
 * Words in one message, with the junk already gone. Both the signature-word
 * and the picked-up-word passes go through here so they can never disagree.
 *
 * Beyond URLs, two shapes are dropped: anything mixing letters and digits
 * (`b87rfyrs7`, `1uy7ggvdw` — ids, never words) and bare numbers including
 * ordinals like `2nd` and years like `2024`, which are quantities rather than
 * vocabulary. Validated against a 154k-message chat: it removes the id soup
 * while keeping real oddities people actually say — `maye`, `duran`,
 * `bregman`, `knicks`, `idno`, `crochet` all survive with hundreds of uses.
 */
export function words(text) {
  const clean = text.toLowerCase().replace(URL_RE, " ").replace(EMAIL_RE, " ");
  const out = [];
  for (const raw of clean.match(/[\p{L}\p{N}']+/gu) ?? []) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length < 3) continue;
    if (/\d/.test(w) && /\p{L}/u.test(w)) continue;   // id-shaped
    if (/^\p{N}+$/u.test(w)) continue;                // bare number
    out.push(w);
  }
  return out;
}

const EMOJI_RE = /(\p{Extended_Pictographic}(\p{Emoji_Modifier}|️)?(‍\p{Extended_Pictographic}(\p{Emoji_Modifier}|️)?)*)/gu;
const LAUGH = /(\blol\b|\blmao\b|\blmfao\b|\bhaha+\b|\bhehe+\b|\bheh\b|😂|🤣|💀)/i;

const inc = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const topN = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const obj = (map) => Object.fromEntries(map);

/**
 * Columns come and go between macOS releases — date_edited and date_retracted
 * only exist from Ventura, when unsend and edit shipped. Ask before selecting
 * them, or the whole report dies on an older copy with "no such column".
 */
/** Below this many read receipts, report the count but not a median. */
export const MIN_READ_SAMPLE = 20;
/** Below this many voice notes, both frontends say "too few to read into". */
export const MIN_AUDIO_SAMPLE = 20;
const readSide = (xs) =>
  xs.length ? { n: xs.length, medianMs: xs.length >= MIN_READ_SAMPLE ? median(xs) : null } : null;

const hasColumns = (db, table, ...cols) => {
  try {
    const have = new Set(db.prepare(`select name from pragma_table_info(?)`).all(table).map((r) => r.name));
    return cols.every((c) => have.has(c));
  } catch { return false; }
};

/**
 * What an attachment actually is.
 *
 * The largest category in a real library is not photos: it's
 * `.pluginPayloadAttachment`, the rich card iMessage builds for a link or an
 * Apple Music track. One 500k-message corpus had 37,573 of them at ~150 KB
 * each. Counted as "things people sent", they make whoever pastes the most
 * links look like a prolific photographer — so they're tracked separately and
 * kept out of the media totals.
 */
const attachmentKind = (mime, uti, name, isSticker) => {
  if (isSticker) return "sticker";
  if (/pluginPayloadAttachment$/i.test(name ?? "")) return "link card";
  if (!mime) {
    if (/coreaudio|audio/i.test(uti ?? "")) return "audio";
    if (/vcard/i.test(uti ?? "")) return "contact";
    return "other";
  }
  if (mime === "image/gif") return "gif";
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (/vcard/i.test(mime)) return "contact";
  if (/vlocation/i.test(mime)) return "location";
  return "other";
};

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
  // Explicit ids ADD to the siblings, they do not replace them. It used to be
  // `mergeIds.length ? [chatId, ...explicit] : ...`, which meant answering the
  // softer same-name-different-roster question silently *dropped* the strict
  // siblings: one work group's thread merged with a 1-message SMS fork and
  // threw away the 5,872-message sibling it had just been reading. The
  // report said "Merged 2 threads" and was smaller than before the merge.
  const ids = [...new Set([chatId, ...(merge ? siblings : []), ...explicit])];

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
 * Everything at once, rather than one conversation.
 *
 * Reads no message text — only ids, dates and directions. That keeps it quick
 * enough to run across a whole library on demand, and means the overview can be
 * browsed without opening a single one of anyone's messages, the same property
 * list-chats.mjs is careful to preserve.
 *
 * One-to-one chats are grouped by who is on the other end rather than by chat
 * row, so a person whose history is split across a recreated thread and an SMS
 * fork counts once, with all of it.
 */
export function overview(db, { names, canonical, now = Date.now(), top = 12 }) {
  // Grouped in SQL, not in JS. Pulling all 700k rows across and counting them
  // here took three seconds, which is too long for the page you land on;
  // letting SQLite do it returns a few thousand rows instead.
  //
  // Integer arithmetic stays inside SQLite, so the nanosecond dates never
  // become JavaScript numbers and never overflow MAX_SAFE_INTEGER.
  const APPLE_EPOCH = 978_307_200;               // 2001-01-01 in unix seconds
  const SECONDS = `(m.date / 1000000000 + ${APPLE_EPOCH})`;
  // 'localtime', to match day() in lib.mjs — these buckets and the JS ones are
  // read side by side, so they have to be the same frame. The modifier order is
  // load-bearing: 'unixepoch' first to say what the number is, then 'localtime'
  // to shift it. SQLite reads the same OS timezone Date does.
  const localFmt = (f) => `strftime('${f}', ${SECONDS}, 'unixepoch', 'localtime')`;

  // One scan, grouped by day and direction; the year comes from the day string.
  // count(distinct) because chat_message_join can file one message against two
  // chats — only 26 times in a 700k-message library, but a total is a total.
  const dayRows = db.prepare(
    `select ${localFmt("%Y-%m-%d")} d, m.is_from_me fromMe, count(distinct m.ROWID) n
       from message m
       join chat_message_join j on j.message_id = m.ROWID
      where ${REAL_MESSAGE_WHERE}
      group by d, fromMe`
  ).all();

  // By month, not by year: comparing "this year so far" against "all of last
  // year" makes everyone look like they're fading, because the current year is
  // always partial. Months let the windows below be a fair 12 against 12.
  const chatRows = db.prepare(
    `select j.chat_id cid, ${localFmt("%Y-%m")} ym, m.is_from_me fromMe, count(*) n,
            min(${DATE_TO_MICROS.replace("date", "m.date")}) first_us,
            max(${DATE_TO_MICROS.replace("date", "m.date")}) last_us
       from message m
       join chat_message_join j on j.message_id = m.ROWID
      where ${REAL_MESSAGE_WHERE}
      group by cid, ym, fromMe`
  ).all();

  const meta = new Map(
    db.prepare(`select ROWID id, display_name dn, chat_identifier ci, style from chat`)
      .all().map((c) => [c.id, c])
  );
  const rosters = chatRosters(db, canonical);

  const byYear = new Map(), byDay = new Map();
  let total = 0, sent = 0, received = 0;
  for (const r of dayRows) {
    if (!r.d) continue;
    const y = Number(r.d.slice(0, 4));
    inc(byDay, r.d, r.n);
    if (!byYear.has(y)) byYear.set(y, { sent: 0, received: 0 });
    byYear.get(y)[r.fromMe === 1 ? "sent" : "received"] += r.n;
    total += r.n;
    if (r.fromMe === 1) sent += r.n; else received += r.n;
  }

  const perChat = new Map();
  let firstMs = Infinity, lastMs = 0;
  for (const r of chatRows) {
    const f = appleMicrosToMs(r.first_us), l = appleMicrosToMs(r.last_us);
    if (!f || !l || !r.ym) continue;
    let c = perChat.get(r.cid);
    if (!c) {
      c = { n: 0, sent: 0, received: 0, first: f, last: l, years: new Map(), months: new Map() };
      perChat.set(r.cid, c);
    }
    c.n += r.n;
    if (r.fromMe === 1) c.sent += r.n; else c.received += r.n;
    if (f < c.first) c.first = f;
    if (l > c.last) c.last = l;
    inc(c.years, Number(r.ym.slice(0, 4)), r.n);
    inc(c.months, r.ym, r.n);
    if (f < firstMs) firstMs = f;
    if (l > lastMs) lastMs = l;
  }

  if (!total) return null;

  const YEAR = 365 * 86_400_000;
  const nameOfHandle = (h) => names.get(h) ?? h;
  // The one fallback chain for naming a chat: display name, then the people
  // in it, then the raw identifier. Written once — this chain had drifted
  // into several hand-rolled copies that disagreed about unnamed groups.
  const chatName = (dn, cid, ci) =>
    dn?.trim() || [...(rosters.get(cid) ?? [])].map(nameOfHandle).sort().join(", ") || ci || `chat ${cid}`;

  // Fold 1:1 chats together by counterpart; keep groups as themselves.
  const byPerson = new Map(), groups = [];
  let automated = 0;
  for (const [cid, c] of perChat) {
    const m = meta.get(cid);
    if (!m) continue;
    // A 1:1 "conversation" with a shortcode is a verification code and a
    // delivery alert. Ranking it beside the people you actually talk to is
    // noise; it is counted here only so the total can say what was left out.
    if (isShortcode(m.ci)) { automated += c.n; continue; }
    const roster = [...(rosters.get(cid) ?? [])];
    if (m.style === 43 || roster.length > 1) {
      groups.push({
        id: cid,
        // Unnamed groups have a chat_identifier like "chat1343308266254744",
        // which tells you nothing. Who's in it does.
        name: chatName(m.dn, cid, m.ci),
        n: c.n, sent: c.sent, received: c.received, first: c.first, last: c.last,
        people: roster.map(nameOfHandle).sort(),
      });
      continue;
    }
    const key = roster[0] ?? canonical(normalizeHandle(m.ci ?? "")) ?? `chat ${cid}`;
    let p = byPerson.get(key);
    if (!p) {
      p = { name: nameOfHandle(key), handle: key, n: 0, sent: 0, received: 0,
            first: c.first, last: c.last, chats: [], years: new Map(), months: new Map() };
      byPerson.set(key, p);
    }
    p.n += c.n; p.sent += c.sent; p.received += c.received;
    p.first = Math.min(p.first, c.first);
    p.last = Math.max(p.last, c.last);
    p.chats.push(cid);
    for (const [y, n] of c.years) inc(p.years, y, n);
    for (const [ym, n] of c.months) inc(p.months, ym, n);
  }

  const people = [...byPerson.values()].sort((a, b) => b.n - a.n);
  const shape = (p) => ({
    name: p.name, n: p.n, sent: p.sent, received: p.received,
    first: p.first, last: p.last,
    // Biggest thread first, so a caller opening chats[0] lands on the main one
    // rather than whichever fork happened to be iterated first.
    chats: [...p.chats].sort((a, b) => (perChat.get(b)?.n ?? 0) - (perChat.get(a)?.n ?? 0)),
    byYear: obj(p.years),
  });

  // Then versus now, over two equal 12-month windows, so "we don't talk any
  // more" becomes measurable rather than a feeling.
  const monthKey = (ms) => day(ms).slice(0, 7);
  const cutRecent = monthKey(now - YEAR), cutPrior = monthKey(now - 2 * YEAR);
  const recentOf = (p) => {
    let recent = 0, prior = 0;
    for (const [ym, n] of p.months) {
      if (ym > cutRecent) recent += n;
      else if (ym > cutPrior) prior += n;
    }
    return { recent, prior };
  };

  const drifted = people
    .filter((p) => p.n >= 200 && now - p.last > 180 * 86_400_000)
    .slice(0, top)
    .map((p) => ({ name: p.name, n: p.n, last: p.last, quietDays: Math.round((now - p.last) / 86_400_000) }));

  const fading = people
    .slice(0, 40)
    .map((p) => ({ p, ...recentOf(p) }))
    .filter((x) => x.prior >= 100)
    .map((x) => ({ name: x.p.name, recent: x.recent, prior: x.prior, change: (x.recent - x.prior) / x.prior }))
    .sort((a, b) => a.change - b.change)
    .slice(0, 8);

  const busiest = topN(byDay, 1)[0];
  const spanDays = Math.floor((lastMs - firstMs) / 86_400_000) + 1;

  /**
   * Conversations with unread messages waiting.
   *
   * `chat.last_read_message_timestamp` is how far you got; the newest incoming
   * message is how far there is to go. Both are nanoseconds since 2001, so the
   * arithmetic stays in SQLite for the same reason as everything else here.
   *
   * Only incoming messages count — your own don't go unread — and a chat with
   * the column at 0 has no read state to compare, which is different from
   * being caught up and is left out rather than reported as behind.
   */
  const unread = hasColumns(db, "chat", "last_read_message_timestamp")
    ? db.prepare(
        `select c.ROWID id, c.display_name dn, c.chat_identifier ci,
                count(distinct m.ROWID) n,
                max(${SECONDS}) lastSec,
                (${SECONDS.replace("m.date", "c.last_read_message_timestamp")}) readSec
           from chat c
           join chat_message_join j on j.chat_id = c.ROWID
           join message m on m.ROWID = j.message_id
          where c.last_read_message_timestamp > 0
            and m.is_from_me = 0
            and m.date > c.last_read_message_timestamp
            and ${REAL_MESSAGE_WHERE}
          group by c.ROWID
          having n > 0
          order by n desc
          limit ?`
      ).all(top)
    : [];

  // `rosters` from the group pass above — recomputing it here ran the full
  // chat_handle_join scan twice on the landing page's already-slow cold build.
  const behind = unread.map((r) => {
    return {
      id: r.id,
      name: chatName(r.dn, r.id, r.ci),
      n: r.n,
      since: r.readSec * 1000,
      last: r.lastSec * 1000,
    };
  });

  return {
    behind,
    total, sent, received,
    first: firstMs, last: lastMs, spanDays,
    perDay: total / spanDays,
    activeDays: byDay.size,
    chats: perChat.size,
    byYear: Object.fromEntries([...byYear.entries()].sort((a, b) => a[0] - b[0])),
    busiestDay: busiest ? { day: busiest[0], n: busiest[1] } : null,
    people: people.slice(0, top).map(shape),
    groups: groups.sort((a, b) => b.n - a.n).slice(0, top),
    // Reported rather than silently dropped — the same rule as link cards and
    // tapbacks. A number that was excluded should be sayable.
    automated,
    drifted,
    fading,
  };
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
    // Built at local midnight rather than by subtracting from `d`, so a week
    // spanning a DST change doesn't land on the previous day at 23:00.
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
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

  const holes = ids.map(() => "?").join(",");

  /* ---- the real reply graph ---- */
  /**
   * `thread_originator_guid` is set when someone uses the inline reply gesture,
   * and it names the exact message being answered. Everything else in this file
   * infers replies from time adjacency, which conflates "answered you" with
   * "happened to speak next" — the usual case where three people are talking at
   * once and the proxy credits whoever was last.
   *
   * The two are kept apart rather than merged. Adjacency covers every message
   * and is a guess; this covers a few percent and is a fact. Reporting a
   * blended number would make both untrustworthy, so the card states its own
   * coverage and lets you judge it.
   *
   * The guid carries no part prefix, unlike `associated_message_guid` — the
   * part is in `thread_originator_part`, which nothing here needs.
   */
  const threadRows = hasColumns(db, "message", "thread_originator_guid")
    ? db.prepare(
        `select m.thread_originator_guid orig, m.is_from_me fromMe, h.id handle,
                ${DATE_TO_MICROS.replace("date", "m.date")} us
           from message m
           join chat_message_join j on j.message_id = m.ROWID
           left join handle h on h.ROWID = m.handle_id
          where j.chat_id in (${holes}) and m.thread_originator_guid is not null
            and ${REAL_MESSAGE_WHERE}`
      ).all(...ids)
    : [];

  const edgeN = new Map();       // "answerer>answered" -> count
  const edgeLag = new Map();     // same key -> latencies
  const answersGiven = new Map();
  const answersGot = new Map();
  let resolved = 0;
  for (const r of threadRows) {
    const target = byGuid.get(r.orig);
    if (!target) continue;       // the answered message is outside this chat
    resolved += 1;
    const from = label(r.handle, r.fromMe === 1);
    const to = target.who;
    inc(answersGiven, from);
    inc(answersGot, to);
    if (from === to) continue;   // answering yourself is not a relationship
    const key = `${from}>${to}`;
    inc(edgeN, key);
    if (!edgeLag.has(key)) edgeLag.set(key, []);
    const lag = appleMicrosToMs(r.us) - target.ms;
    if (lag >= 0) edgeLag.get(key).push(lag);
  }
  const replyGraph = resolved === 0 ? null : {
    // Say how much of the conversation this is built from — a few percent is
    // normal, and a reader who doesn't know that will over-read the ranking.
    used: resolved,
    share: resolved / total,
    edges: [...edgeN.entries()]
      .map(([k, n]) => {
        const [from, to] = k.split(">");
        const lags = edgeLag.get(k) ?? [];
        return { from, to, n, medianMs: lags.length >= 5 ? median(lags) : null };
      })
      .sort((a, b) => b.n - a.n),
    perPerson: people.map((p) => ({
      who: p, given: answersGiven.get(p) ?? 0, got: answersGot.get(p) ?? 0,
    })).sort((a, b) => b.got - a.got),
  };

  /* ---- group history: renames, joins, leaves ---- */
  /**
   * These are messages with `item_type <> 0`, which is why a fifth of the
   * `message` table isn't messages. Three types are confirmed against known
   * events in a real corpus:
   *
   *   item_type 2  — renamed; the new name is in `group_title`
   *   item_type 1  — roster change; group_action_type 0 added, 1 removed
   *   item_type 3  — the sender left of their own accord
   *
   * `other_handle` is the **handle ROWID** of the person acted on, not a
   * handle string — joining it as text finds nothing, which is the trap that
   * makes this look like empty data.
   *
   * item_type 4, 5 and 6 also exist (191 rows in that corpus). They carry no
   * text, no target and no distinguishing column, so they are left out rather
   * than guessed at.
   */
  const events = hasColumns(db, "message", "item_type", "group_action_type", "other_handle")
    ? db.prepare(
        `select m.item_type it, m.group_action_type ga, m.group_title title,
                m.is_from_me fromMe, h.id actor, oh.id target,
                ${DATE_TO_MICROS.replace("date", "m.date")} us
           from message m
           join chat_message_join j on j.message_id = m.ROWID
           left join handle h  on h.ROWID = m.handle_id
           left join handle oh on oh.ROWID = CAST(m.other_handle as INTEGER)
          where j.chat_id in (${holes}) and m.item_type in (1, 2, 3)
          order by m.date asc`
      ).all(...ids)
    : [];

  const history = [];
  const seenEvent = new Set();
  for (const e of events) {
    const ms = appleMicrosToMs(e.us);
    const actor = label(e.actor, e.fromMe === 1);
    const target = e.target ? label(e.target, false) : null;
    const kind = e.it === 2 ? "renamed" : e.it === 3 ? "left" : e.ga === 1 ? "removed" : "added";
    if (kind !== "renamed" && !target && kind !== "left") continue;
    // The same event is often recorded twice; collapse by what it says, to the
    // day, so a duplicate doesn't read as two separate departures.
    const key = `${day(ms)}|${kind}|${target ?? e.title ?? ""}`;
    if (seenEvent.has(key)) continue;
    seenEvent.add(key);
    history.push({ ms, kind, actor, target, title: e.title ?? null });
  }

  /**
   * People with messages here who are on no current roster — they left, so
   * `chat_handle_join` forgot them while their messages remain. Without the
   * history above they are senders who appear on no membership list at all.
   *
   * The roster comes from `chatRosters`, not from `chat`, which is the raw row
   * and carries no membership.
   */
  const rosters = chatRosters(db, canonical);
  const rosterNow = new Set();
  for (const id of ids) for (const h of rosters.get(id) ?? []) rosterNow.add(names.get(h) ?? h);
  const me = label(null, true);
  const departed = people.filter((p) => p !== me && !rosterNow.has(p));

  /* ---- tapbacks ---- */
  // 2000–2007 add a tapback, 3000–3007 take one back. Reading only the adds
  // counts a reaction somebody removed; ordering by date and keeping the last
  // state per (part, reactor) settles both removals and changes.
  // The any-emoji reaction (type 2006) keeps the chosen emoji in its own
  // column, so "emoji 93" can say which ones instead of standing for all of
  // them. Newer than the rest of this table, hence the guard.
  const hasEmojiCol = hasColumns(db, "message", "associated_message_emoji");
  const taps = db
    .prepare(
      `select m.guid self, m.associated_message_guid guid,
              m.associated_message_type amt, m.is_from_me fromMe, h.id handle,
              ${hasEmojiCol ? "m.associated_message_emoji" : "null"} emoji
         from message m
         join chat_message_join j on j.message_id = m.ROWID
         left join handle h on h.ROWID = m.handle_id
        where j.chat_id in (${holes})
          and m.associated_message_type between 2000 and 3007
        order by m.date asc`
    )
    .all(...ids);

  const given = new Map(), received = new Map(), kinds = new Map();
  /**
   * How many *people* reacted to a message — not how many tapback rows it has.
   *
   * A tapback targets one *part*, and `associated_message_guid` carries the
   * part as a prefix: `p:3/<guid>`. A message that is a photo dump is one
   * message with many parts, so one person hearting fifteen of eighteen photos
   * produced "15×" in a two-person chat. Counting distinct reactors bounds the
   * number by the roster, which is the only reading that means anything.
   */
  const reactors = new Map();   // target guid -> Set of people
  const latest = new Map();     // "reactor|part-qualified guid" -> amt
  const seenTaps = new Set();
  for (const t of taps) {
    if (seenTaps.has(t.self)) continue;
    seenTaps.add(t.self);
    latest.set(`${label(t.handle, t.fromMe === 1)}|${t.guid ?? ""}`, t);
  }
  const kindsBy = new Map();   // person -> kind -> n, for the per-person mix
  const customEmoji = new Map();
  for (const t of latest.values()) {
    if (t.amt >= 3000) continue;               // taken back — never happened
    const who = label(t.handle, t.fromMe === 1);
    const kind = TAPBACK_KINDS[t.amt] ?? String(t.amt);
    if (t.emoji) inc(customEmoji, t.emoji);
    inc(given, who);
    inc(kinds, kind);
    if (!kindsBy.has(who)) kindsBy.set(who, new Map());
    inc(kindsBy.get(who), kind);
    // associated_message_guid is prefixed, e.g. "p:0/<guid>" — take the tail
    const target = t.guid?.includes("/") ? t.guid.split("/").pop() : t.guid ?? "";
    const hit = byGuid.get(target);
    if (hit) {
      inc(received, hit.who);
      if (!reactors.has(target)) reactors.set(target, new Set());
      reactors.get(target).add(who);
    }
  }
  const perMsg = new Map([...reactors].map(([g, s]) => [g, s.size]));

  /* ---- attachments ---- */
  const attRows = hasColumns(db, "attachment", "mime_type", "uti", "total_bytes", "is_sticker", "transfer_name")
    ? db.prepare(
        `select distinct a.ROWID aid, a.mime_type mime, a.uti uti, a.transfer_name name,
                a.total_bytes bytes, a.is_sticker sticker,
                m.is_from_me fromMe, h.id handle,
                ${DATE_TO_MICROS.replace("date", "m.date")} us
           from attachment a
           join message_attachment_join maj on maj.attachment_id = a.ROWID
           join message m on m.ROWID = maj.message_id
           join chat_message_join j on j.message_id = m.ROWID
           left join handle h on h.ROWID = m.handle_id
          where j.chat_id in (${holes})`
      ).all(...ids)
    : [];

  const attBy = new Map(), attBytesBy = new Map(), attKinds = new Map(), attByYear = new Map();
  const attKindBy = new Map();
  /**
   * Camera roll vs screen capture, from the filename.
   *
   * A screenshot and a photograph are both `image/*` and indistinguishable by
   * mime type, but iOS names them differently: `IMG_1234` off the camera,
   * `Screenshot …` or `Simulator Screen Shot …` off the screen, `RPReplay…`
   * for a screen recording. It is the difference between someone sending you
   * their life and someone sending you their phone.
   */
  const shotsBy = new Map(), photosBy = new Map(), recordingsBy = new Map();
  const seenAtt = new Set();
  let attMedia = 0, attBytes = 0, attCards = 0;
  for (const a of attRows) {
    if (seenAtt.has(a.aid)) continue;
    seenAtt.add(a.aid);
    const kind = attachmentKind(a.mime, a.uti, a.name, a.sticker === 1);
    inc(attKinds, kind);
    if (kind === "link card") { attCards += 1; continue; }
    const who = label(a.handle, a.fromMe === 1);
    attMedia += 1;
    attBytes += a.bytes ?? 0;
    inc(attBy, who);
    inc(attBytesBy, who, a.bytes ?? 0);
    if (!attKindBy.has(who)) attKindBy.set(who, new Map());
    inc(attKindBy.get(who), kind);
    const nm = a.name ?? "";
    if (/RPReplay|ScreenRecording/i.test(nm)) inc(recordingsBy, who);
    else if (/screen ?shot/i.test(nm)) inc(shotsBy, who);
    else if (kind === "photo" && /^(IMG|FullSizeRender|DSC|PXL)/i.test(nm)) inc(photosBy, who);
    const ms = appleMicrosToMs(a.us);
    if (ms) inc(attByYear, new Date(ms).getFullYear());
  }

  /* ---- apps, and voice notes ---- */
  /**
   * `balloon_bundle_id` names the extension that drew a bubble. The URL
   * previewer dominates everywhere and is already covered by the link section,
   * so it is dropped here — what's left is the long tail: polls, Find My,
   * Apple Cash, games. A line, not a section.
   */
  /**
   * Counting app bubbles is counting *sessions*, not rows. Every vote on a
   * poll and every game move writes another row with the same bundle id
   * (associated_message_type 2/3/4000), chained to the balloon it updates via
   * `associated_message_guid` — and the chains are transitive: a poll's update
   * can itself be updated. Row counts reported one poll voted on twenty times
   * as "poll 21"; filtering to associated_message_type = 0 was wrong in the
   * other direction, dropping polls whose *every* row is an update type.
   *
   * The rows are rare (hundreds in a whole library), so the exact answer is
   * affordable: pull them and count chain roots.
   */
  const appRows = hasColumns(db, "message", "balloon_bundle_id")
    ? db.prepare(
        `select distinct m.ROWID rid, m.guid g, m.associated_message_guid ag, m.balloon_bundle_id b
           from message m
           join chat_message_join j on j.message_id = m.ROWID
          where j.chat_id in (${holes}) and m.balloon_bundle_id is not null
            and m.balloon_bundle_id <> 'com.apple.messages.URLBalloonProvider'`
      ).all(...ids)
    : [];
  // Follow each row to its chain root. The target guid may carry a part
  // prefix (p:0/<guid>) like tapbacks do — take the tail.
  const appByGuid = new Map(appRows.map((r) => [r.g, r]));
  const rootOf = (r) => {
    for (let hops = 0; r.ag && hops < 32; hops += 1) {
      const target = appByGuid.get(r.ag.includes("/") ? r.ag.split("/").pop() : r.ag);
      if (!target || target === r) break;
      r = target;
    }
    return r.g;
  };
  // com.apple.messages.MSMessageExtensionBalloonPlugin:TEAMID:bundle.id — and
  // third-party bundles end in a generic segment (.MessagesExtension, .ext),
  // so taking the last dotted component collapsed every such app into the
  // same name. Strip the generic tail; aggregation happens after renaming,
  // so two ids that become one name merge instead of duplicating.
  const GENERIC_TAIL = /^(messagesextensions?|messagesappextension|messagesapp|imessageextension|extension|ext)$/i;
  const appSessions = new Map();   // name -> Set of chain roots
  for (const r of appRows) {
    const parts = String(r.b).split(":").pop().split(".").filter(Boolean);
    while (parts.length > 1 && GENERIC_TAIL.test(parts[parts.length - 1])) parts.pop();
    const name = parts[parts.length - 1] ?? String(r.b);
    if (!appSessions.has(name)) appSessions.set(name, new Set());
    appSessions.get(name).add(rootOf(r));
  }
  const apps = [...appSessions.entries()]
    .map(([name, roots]) => ({ name, n: roots.size }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);

  /**
   * Voice notes. Almost nobody sends them — 129 in a 890k-message library — so
   * this reports counts and never a rate.
   *
   * Direction matters: `is_played` is only ever set on *received* audio (your
   * own sends never get a local played mark), so a lumped "10 sent, 3 played"
   * implied 7 were ignored when every receivable one was played. Sent and
   * received are reported separately, and played only against received.
   */
  const audio = hasColumns(db, "message", "is_audio_message", "is_played")
    ? db.prepare(
        `select count(distinct case when m.is_from_me = 1 then m.ROWID end) sent,
                count(distinct case when m.is_from_me = 0 then m.ROWID end) received,
                count(distinct case when m.is_from_me = 0 and m.is_played = 1 then m.ROWID end) played
           from message m
           join chat_message_join j on j.message_id = m.ROWID
          where j.chat_id in (${holes}) and m.is_audio_message = 1
            and ${REAL_MESSAGE_WHERE}`
      ).get(...ids)
    : null;

  /* ---- what the links actually were ---- */
  /**
   * Every domain histogram elsewhere says people shared 81 things from x.com.
   * `payload_data` says *what* they were: iMessage archives an `LPLinkMetadata`
   * — title, site name, summary — when the preview card is built, and keeps it.
   *
   * This is captured at send time and stored locally, which is the only reason
   * it can exist here at all. Fetching a shared URL to get its title would
   * leak the contents of a private conversation to whoever runs that domain,
   * and there is no network client in this project by design.
   *
   * The URL sits under the dotted key `NS.relative`, not a nested object.
   */
  const linkRows = hasColumns(db, "message", "payload_data", "balloon_bundle_id")
    ? db.prepare(
        `select m.payload_data pd, m.is_from_me fromMe, h.id handle,
                ${DATE_TO_MICROS.replace("date", "m.date")} us
           from message m
           join chat_message_join j on j.message_id = m.ROWID
           left join handle h on h.ROWID = m.handle_id
          where j.chat_id in (${holes})
            and m.balloon_bundle_id = 'com.apple.messages.URLBalloonProvider'
            and m.payload_data is not null`
      ).all(...ids)
    : [];

  const sites = new Map(), byUrl = new Map();
  const titled = [];
  for (const r of linkRows) {
    let md;
    // A corrupt or unfamiliar archive must not take the whole report down.
    try { md = readArchive(Buffer.from(r.pd)); } catch { continue; }
    const meta = md?.richLinkMetadata ?? md;
    if (!meta || typeof meta !== "object") continue;
    // Titles from social cards carry their own layout — "Name (@handle)\n3K
    // likes · 26 replies" — which breaks any single-line rendering.
    const title = typeof meta.title === "string" ? meta.title.replace(/\s+/g, " ").trim() : "";
    if (!title) continue;                       // placeholder card, no metadata
    const url = typeof meta.URL?.["NS.relative"] === "string" ? meta.URL["NS.relative"] : null;
    const site = typeof meta.siteName === "string" && meta.siteName.trim() ? meta.siteName.trim() : null;
    const who = label(r.handle, r.fromMe === 1);
    const ms = appleMicrosToMs(r.us);
    if (site) inc(sites, site);
    const entry = { title, site, url, who, ms, summary: typeof meta.summary === "string" ? meta.summary.trim() : null };
    titled.push(entry);
    if (url) {
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(entry);
    }
  }
  titled.sort((a, b) => b.ms - a.ms);
  const richLinks = titled.length === 0 ? null : {
    // Cards without metadata are real links that simply never resolved a
    // preview; saying how many keeps the titled list from reading as all of them.
    titled: titled.length,
    cards: linkRows.length,
    topSites: topN(sites, 12).map(([site, n]) => ({ site, n })),
    recent: titled.slice(0, 12).map(({ title, site, who, ms, url }) => ({ title, site, who, ms, url })),
    // The same link sent twice is usually one person forgetting, or two people
    // finding it independently — both are funnier than a domain count.
    reposts: [...byUrl.entries()]
      .filter(([, xs]) => xs.length > 1)
      .map(([url, xs]) => ({
        url, title: xs[0].title, site: xs[0].site, n: xs.length,
        who: [...new Set(xs.map((x) => x.who))],
        first: Math.min(...xs.map((x) => x.ms)), last: Math.max(...xs.map((x) => x.ms)),
      }))
      .sort((a, b) => b.n - a.n || b.last - a.last)
      .slice(0, 8),
  };

  /* ---- how it was sent: iMessage, SMS, RCS ---- */
  /**
   * `service` is per message, so a green bubble is really "this person was on
   * Android, or off wifi, when they sent it". Only worth showing when a
   * conversation actually mixes — an all-iMessage chat learns nothing from a
   * row of 100%s.
   */
  const svcRows = hasColumns(db, "message", "service")
    ? db.prepare(
        `select m.service svc, m.is_from_me fromMe, h.id handle, count(*) n,
                min(${DATE_TO_MICROS.replace("date", "m.date")}) firstUs,
                max(${DATE_TO_MICROS.replace("date", "m.date")}) lastUs
           from message m
           join chat_message_join j on j.message_id = m.ROWID
           left join handle h on h.ROWID = m.handle_id
          where j.chat_id in (${holes}) and ${REAL_MESSAGE_WHERE}
          group by m.service, m.is_from_me, h.id`
      ).all(...ids)
    : [];
  const svcBy = new Map(), svcTotals = new Map();
  const svcSpan = new Map();
  for (const r of svcRows) {
    const who = label(r.handle, r.fromMe === 1);
    const svc = r.svc ?? "unknown";
    if (!svcBy.has(who)) svcBy.set(who, new Map());
    inc(svcBy.get(who), svc, r.n);
    inc(svcTotals, svc, r.n);
    const cur = svcSpan.get(svc) ?? { first: Infinity, last: 0 };
    svcSpan.set(svc, {
      first: Math.min(cur.first, appleMicrosToMs(r.firstUs)),
      last: Math.max(cur.last, appleMicrosToMs(r.lastUs)),
    });
  }
  const services = svcTotals.size > 1 ? {
    totals: [...svcTotals.entries()].sort((a, b) => b[1] - a[1])
      .map(([name, n]) => ({ name, n, first: svcSpan.get(name).first, last: svcSpan.get(name).last })),
    people: people.map((p) => ({
      who: p,
      mix: Object.fromEntries(svcBy.get(p) ?? []),
      n: [...(svcBy.get(p) ?? [])].reduce((s, [, v]) => s + v, 0),
    })).filter((p) => p.n),
  } : null;

  /* ---- unsent + edited ---- */
  // case-when rather than selecting the timestamps: these are nanosecond
  // columns too, and reading one raw overflows Number.MAX_SAFE_INTEGER.
  const editRows = hasColumns(db, "message", "date_retracted", "date_edited")
    ? db.prepare(
        `select distinct m.guid guid, m.is_from_me fromMe, h.id handle,
                case when m.date_retracted != 0 then 1 else 0 end unsent,
                case when m.date_edited != 0 then 1 else 0 end edited
           from message m
           join chat_message_join j on j.message_id = m.ROWID
           left join handle h on h.ROWID = m.handle_id
          where j.chat_id in (${holes})
            and (m.date_retracted != 0 or m.date_edited != 0)`
      ).all(...ids)
    : [];

  const unsentBy = new Map(), editedBy = new Map();
  const seenEdit = new Set();
  let unsentTotal = 0, editedTotal = 0;
  for (const e of editRows) {
    if (seenEdit.has(e.guid)) continue;
    seenEdit.add(e.guid);
    const who = label(e.handle, e.fromMe === 1);
    if (e.unsent) { inc(unsentBy, who); unsentTotal += 1; }
    if (e.edited) { inc(editedBy, who); editedTotal += 1; }
  }

  /* ---- read receipts ---- */
  // date_read is only populated when the reader has read receipts switched on,
  // so this is always partial and sometimes absent entirely. On an outgoing
  // message it's when they read yours; on an incoming one, when you read theirs.
  const readRows = hasColumns(db, "message", "date_read")
    ? db.prepare(
        `select distinct m.guid guid, m.is_from_me fromMe,
                ${DATE_TO_MICROS.replace("date", "m.date")} sent,
                ${DATE_TO_MICROS.replace("date", "m.date_read")} seen
           from message m
           join chat_message_join j on j.message_id = m.ROWID
          where j.chat_id in (${holes}) and ${REAL_MESSAGE_WHERE} and m.date_read != 0`
      ).all(...ids)
    : [];

  const readByMe = [], readByThem = [];
  const seenRead = new Set();
  for (const r of readRows) {
    if (seenRead.has(r.guid)) continue;
    seenRead.add(r.guid);
    const sentMs = appleMicrosToMs(r.sent), seenMs = appleMicrosToMs(r.seen);
    if (!sentMs || !seenMs) continue;
    const dt = seenMs - sentMs;
    if (dt < 0) continue;   // clock skew across devices
    (r.fromMe === 1 ? readByThem : readByMe).push(dt);
  }

  /* ---- words + emoji ---- */
  const wordsBy = new Map(), totalWordsBy = new Map(), firstUse = new Map();
  const emojiBy = new Map(), emojiAll = new Map();
  // vocab is filled here rather than in the odds-and-ends pass below: words()
  // is the most expensive per-message call in the file (~190ms per 150k
  // messages), and running it twice over every message doubled that for
  // nothing. vocab deliberately includes stop words — it measures distinct
  // words used, not distinctive ones.
  const vocab = new Map();
  for (const m of msgs) {
    if (!wordsBy.has(m.who)) {
      wordsBy.set(m.who, new Map()); emojiBy.set(m.who, new Map());
      totalWordsBy.set(m.who, 0); firstUse.set(m.who, new Map());
      vocab.set(m.who, new Set());
    }
    const vs = vocab.get(m.who);
    for (const w of words(m.text)) {
      vs.add(w);
      if (STOP.has(w)) continue;
      inc(wordsBy.get(m.who), w);
      if (!firstUse.get(m.who).has(w)) firstUse.get(m.who).set(w, m.ms);
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

  /**
   * WORDS THEY PICKED UP. A different question from signature words: not what
   * marks someone out from everyone else, but what entered their vocabulary
   * partway through and stuck. Requires a first use at least a fifth of the way
   * into the history — anything earlier was always there — and enough uses
   * afterwards that it became a habit rather than a one-off.
   */
  const spanMs = last.ms - first.ms || 1;
  const pickedUp = ranked.map(([who]) => {
    const words = [];
    for (const [w, n] of wordsBy.get(who)) {
      if (n < minUses) continue;
      const at = firstUse.get(who).get(w);
      const into = (at - first.ms) / spanMs;
      if (into < 0.2) continue;
      words.push({ word: w, n, at, into });
    }
    // Latest arrivals that still caught on: rank by uses, break ties by lateness.
    words.sort((a, b) => b.n - a.n || b.into - a.into);
    return { who, words: words.slice(0, 6) };
  }).filter((s) => s.words.length);

  /* ---- odds and ends ---- */
  const laughs = new Map(), questions = new Map(), shouts = new Map();
  // vocab lives in the words pass above — same tokenizer as the word counts,
  // filled in the one place words() runs.
  const links = new Map(), domains = new Map(), exact = new Map();
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
    const key = m.text.trim().toLowerCase();
    if (key.length >= 2 && key.length <= 40) inc(exact, key);
  }

  const msgRef = (m) => m && { who: m.who, ms: m.ms, text: m.text, len: m.len, guid: m.guid };

  return {
    chat: {
      id: chat.id,
      // A one-to-one chat has no display_name, and chat_identifier is a raw
      // phone number — so picking a named person in the sidebar used to open a
      // report titled with their number. Fall back to whoever is in it instead.
      name: chat.display_name?.trim()
        || people.filter((p) => p !== label(null, true)).join(", ")
        || chat.chat_identifier || `chat ${chat.id}`,
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
      // Their mix of reaction kinds, for the per-person breakdown.
      gaveKinds: Object.fromEntries(kindsBy.get(who) ?? []),
      laughs: laughs.get(who) ?? 0,
      questions: questions.get(who) ?? 0,
      shouts: shouts.get(who) ?? 0,
      links: links.get(who) ?? 0,
      vocab: vocab.get(who)?.size ?? 0,
      attachments: attBy.get(who) ?? 0,
      attachmentBytes: attBytesBy.get(who) ?? 0,
      attachmentKinds: topN(attKindBy.get(who) ?? new Map(), 6).map(([kind, n]) => ({ kind, n })),
      screenshots: shotsBy.get(who) ?? 0,
      cameraPhotos: photosBy.get(who) ?? 0,
      screenRecordings: recordingsBy.get(who) ?? 0,
      unsent: unsentBy.get(who) ?? 0,
      edited: editedBy.get(who) ?? 0,
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
      kinds: topN(kinds, 9).map(([kind, n]) => ({ kind, n, icon: TAPBACK_ICONS[kind] ?? "•" })),
      // Which emoji people actually picked, rather than "emoji, 93 of them".
      customEmoji: topN(customEmoji, 10).map(([emoji, n]) => ({ emoji, n })),
      mostReacted: topN(perMsg, 8)
        .map(([g, n]) => ({ n, msg: msgRef(byGuid.get(g)) }))
        .filter((x) => x.msg),
    },
    richLinks,
    apps: apps.length ? apps : null,
    // `sparse` is the data layer's call, like MIN_READ_SAMPLE — both frontends
    // used to hard-code the same threshold separately, which is how they drift.
    audio: (audio?.sent || audio?.received)
      ? { sent: audio.sent, received: audio.received, played: audio.played,
          sparse: audio.sent + audio.received < MIN_AUDIO_SAMPLE }
      : null,
    services,
    replyGraph,
    groupHistory: history.length || departed.length ? { events: history, departed } : null,
    signature: { minUses, people: signature },
    pickedUp: pickedUp.length ? { minUses, people: pickedUp } : null,
    attachments: attMedia === 0 && attCards === 0 ? null : {
      total: attMedia,
      bytes: attBytes,
      // Kept apart from the media count on purpose — see attachmentKind().
      linkCards: attCards,
      kinds: topN(attKinds, 9).map(([kind, n]) => ({ kind, n })),
      byYear: obj(attByYear),
    },
    edits: unsentTotal === 0 && editedTotal === 0 ? null : {
      unsent: unsentTotal,
      edited: editedTotal,
    },
    // medianMs is null below MIN_READ_SAMPLE. Read receipts are off far more
    // often than they're on, and one real corpus had 27,164 samples in one
    // direction and 7 in the other — a median of 7 is a number, not a fact.
    read: readByMe.length + readByThem.length === 0 ? null : {
      byMe: readSide(readByMe),
      byThem: readSide(readByThem),
      coverage: (readByMe.length + readByThem.length) / total,
    },
    emoji: { overall: topN(emojiAll, 14).map(([emoji, n]) => ({ emoji, n })) },
    odds: {
      domains: topN(domains, 8).map(([domain, n]) => ({ domain, n })),
      repeated: topN(exact, 8).map(([text, n]) => ({ text, n })),
      firstMsg: msgRef(first),
      lastMsg: msgRef(last),
    },
  };
}
