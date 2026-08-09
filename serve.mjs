/**
 * MessageStats — local web UI.  node serve.mjs  →  http://127.0.0.1:4173
 *
 * Binds to loopback only. The database is opened read-only, exactly as the CLI
 * opens it.
 *
 * Exactly one code path in this project can reach the network: the optional
 * assistant, which is the single `fetch` in llm.mjs and does nothing until the
 * user creates ai.local.json. Everything else — analysis, search, importing a
 * snapshot, building names — is local. Verify with:
 *     grep -rn "fetch(\|http\.request\|net\.connect" *.mjs
 *
 * Every number the browser shows comes from analyze.mjs, the same module
 * stats.mjs prints from, so the web UI and the terminal cannot disagree.
 *
 * Flags:  --port 4173   --db path/to/chat.db   --names names.json
 */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { copyFile, stat as statAsync } from "node:fs/promises";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  appleMicrosToMs, arg, chatRosters, chatSummaries, DATE_TO_MICROS,
  findSameNameChats, findSiblingChats, loadIdentities, messageText,
  normalizeHandle, openDb, REAL_MESSAGE_WHERE, resolveDbPath, resolveNamesPath,
  dataDir,
} from "./lib.mjs";
import { analyze, loadMessages, overview, resolveChats, resolveMe } from "./analyze.mjs";
import { ask as llmAsk, listModels, loadConfig as loadAiConfig, PROVIDERS } from "./llm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const PORT = Number(arg(argv, "port") ?? 4173);
const NAMES_PATH = resolveNamesPath(argv);
// Your data lives outside the repo: git pull replaces the repo on every launch.
const DATA = dataDir();
const DB_PATH = resolveDbPath(argv);

/* ---------------- state ---------------- */

// Opened lazily so the server still starts (and can explain itself) when there
// is no database yet — which is exactly the first-run case.
let db = null;
let ids = null;
const cache = new Map();

function identities() {
  return loadIdentities(NAMES_PATH);
}

function getDb() {
  if (db) return db;
  if (!existsSync(DB_PATH)) return null;
  db = openDb(DB_PATH);
  return db;
}

/** Drop memoised analysis — after names.json changes, every label is stale. */
function invalidate() {
  cache.clear();
  ids = null;
}

/* ---------------- data ---------------- */

function status() {
  const dbFound = existsSync(DB_PATH);
  const out = {
    db: { found: dbFound, path: DB_PATH, wal: existsSync(`${DB_PATH}-wal`) },
    names: { found: existsSync(NAMES_PATH), path: NAMES_PATH, count: 0 },
    ready: false,
  };
  if (dbFound) out.db.sizeMB = Math.round(statSync(DB_PATH).size / 1e6);
  if (out.names.found) {
    try {
      const raw = JSON.parse(readFileSync(NAMES_PATH, "utf8"));
      out.names.count = Object.keys(raw.names ?? raw ?? {}).length;
    } catch { out.names.error = "names.json is not valid JSON"; }
  }
  const d = getDb();
  if (!d) return out;

  const newest = d
    .prepare(`select max(${DATE_TO_MICROS.replace("date", "m.date")}) us from message m where ${REAL_MESSAGE_WHERE}`)
    .get();
  const newestMs = newest?.us ? appleMicrosToMs(newest.us) : null;
  out.db.newest = newestMs;
  out.db.ageHours = newestMs ? (Date.now() - newestMs) / 3.6e6 : null;

  // Busiest senders with no name yet — the thing that most degrades a report.
  // Cached: this groups every message row by handle, which is seconds on a large
  // library, and /api/status is hit repeatedly while the app starts up.
  if (!cache.has("unnamed")) {
    const { names, canonical } = identities();
    const unnamed = new Map();
    for (const r of d.prepare(
      `select h.id hid, count(*) n from message m
         join chat_message_join j on j.message_id = m.ROWID
         join handle h on h.ROWID = m.handle_id
        where ${REAL_MESSAGE_WHERE} group by h.id`
    ).all()) {
      if (names.get(canonical(normalizeHandle(r.hid)))) continue;
      unnamed.set(r.hid, (unnamed.get(r.hid) ?? 0) + r.n);
    }
    cache.set("unnamed", {
      list: [...unnamed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
        .map(([handle, n]) => ({ handle, n })),
      total: unnamed.size,
    });
  }
  out.names.unnamed = cache.get("unnamed").list;
  out.names.unnamedTotal = cache.get("unnamed").total;
  out.ready = true;
  return out;
}

/* ---------------- importing from the live Messages folder ---------------- */

const LIVE_DIR = path.join(os.homedir(), "Library", "Messages");
const PARTS = ["chat.db", "chat.db-wal", "chat.db-shm"];

/**
 * Can we read ~/Library/Messages?
 *
 * That folder is TCC-protected, so this is really asking "does the process
 * running node have Full Disk Access". There is no way to *prompt* for FDA the
 * way you can for Contacts — the user has to add their terminal in System
 * Settings by hand and restart it — so all we can do is detect and explain.
 */
function source() {
  const out = { dir: LIVE_DIR, readable: false, parts: [], messagesRunning: null };
  try {
    // Actually read a byte. statSync can succeed where reading is refused.
    const fd = openSync(path.join(LIVE_DIR, "chat.db"), "r");
    const b = Buffer.alloc(16);
    readSync(fd, b, 0, 16, 0);
    closeSync(fd);
    out.readable = b.toString("latin1").startsWith("SQLite format 3");
  } catch (err) {
    out.error = err.code || err.message;
    return out;
  }
  for (const p of PARTS) {
    try { out.parts.push({ name: p, bytes: statSync(path.join(LIVE_DIR, p)).size }); }
    catch { out.parts.push({ name: p, bytes: null }); }
  }
  return out;
}

const messagesRunning = () => new Promise((res) =>
  execFile("/usr/bin/pgrep", ["-x", "Messages"], (err, out) => res(!err && Boolean(out.trim()))));

/**
 * Copy the three files here. All three: chat.db alone opens fine and silently
 * omits whatever is still in the write-ahead log, which is exactly the most
 * recent history.
 */
async function importSnapshot() {
  const src = source();
  if (!src.readable) return { ok: false, error: "no-access", detail: src.error ?? "unreadable" };
  // Release our handle first — we're about to overwrite the file underneath it.
  if (db) { db.close(); db = null; }
  invalidate();
  const copied = [];
  for (const p of PARTS) {
    const from = path.join(LIVE_DIR, p);
    if (!existsSync(from)) continue;
    await copyFile(from, path.join(DATA, p));
    copied.push({ name: p, bytes: (await statAsync(path.join(DATA, p))).size });
  }
  return { ok: true, copied, messagesRunning: await messagesRunning() };
}

function chats({ min = 1, limit = 400 } = {}) {
  const d = getDb();
  if (!d) return [];
  const { names, canonical } = identities();
  const rows = d.prepare(
    `select c.ROWID id, c.display_name dn, c.chat_identifier ci, c.style style,
            count(m.ROWID) n,
            min(${DATE_TO_MICROS.replace("date", "m.date")}) first_us,
            max(${DATE_TO_MICROS.replace("date", "m.date")}) last_us
       from chat c
       join chat_message_join j on j.chat_id = c.ROWID
       join message m on m.ROWID = j.message_id
      where ${REAL_MESSAGE_WHERE}
      group by c.ROWID having count(m.ROWID) >= ?
      order by n desc limit ?`
  ).all(min, limit);

  const sib = findSiblingChats(d, canonical);
  const same = findSameNameChats(d, canonical);
  const extra = chatSummaries(d, rows.flatMap((r) => [...(sib.get(r.id) ?? []), ...(same.get(r.id) ?? [])]));
  const live = (list, self) => (list ?? []).filter((x) => x !== self && (extra.get(x)?.n ?? 0) > 0)
    .map((x) => ({ id: x, n: extra.get(x).n }));
  const roster = d.prepare(
    `select h.id id from chat_handle_join j join handle h on h.ROWID = j.handle_id where j.chat_id = ?`
  );

  return rows.map((r) => {
    const people = [...new Set(roster.all(r.id).map((h) => names.get(canonical(normalizeHandle(h.id))) ?? h.id))];
    const siblings = live(sib.get(r.id), r.id);
    const named = live(same.get(r.id), r.id).filter((x) => !siblings.some((s) => s.id === x.id));
    return {
      id: r.id, n: r.n, people,
      isGroup: r.style === 43,
      name: r.dn?.trim() || (r.style === 43 ? "(unnamed group)" : people[0] ?? r.ci ?? "?"),
      first: appleMicrosToMs(r.first_us), last: appleMicrosToMs(r.last_us),
      siblings, named,
      missing: siblings.reduce((s, x) => s + x.n, 0),
    };
  });
}

function chatDetail(chatId, { merge = false, mergeIds = [], top = 10 }) {
  const d = getDb();
  if (!d) return null;
  const key = `${chatId}|${merge}|${mergeIds.join(",")}|${top}`;
  if (cache.has(key)) return cache.get(key);

  const { names, canonical } = identities();
  const resolved = resolveChats(d, { chatId, merge, mergeIds, canonical });
  if (!resolved) return null;
  const meName = resolveMe(d, resolved.ids, { names, canonical });
  const { msgs, byGuid, label } = loadMessages(d, resolved.ids, { names, canonical, meName });
  if (msgs.length < 2) return { error: `Only ${msgs.length} readable message(s).` };

  const A = analyze(d, { ids: resolved.ids, msgs, byGuid, label, chat: resolved.chat, top, names, canonical });
  // Names the merged threads used to go by — how you recognise a renamed chat.
  const holes = resolved.ids.map(() => "?").join(",");
  A.aka = [...new Set(
    d.prepare(`select display_name dn from chat where ROWID in (${holes})`)
      .all(...resolved.ids).map((r) => r.dn?.trim()).filter(Boolean)
  )].filter((n) => n !== A.chat.name);

  const rosters = chatRosters(d, canonical);
  A.threads = resolved.ids.map((id) => {
    const s = resolved.siblings.concat(resolved.named).find((x) => x.id === id);
    return {
      id, n: s?.n ?? null, first: s?.first ?? null, last: s?.last ?? null,
      roster: [...(rosters.get(id) ?? [])].map((h) => names.get(h) ?? h).sort(),
    };
  });
  A.rostersDiffer = new Set(A.threads.map((t) => t.roster.join("|"))).size > 1;
  A.siblings = resolved.siblings;
  A.named = resolved.named;
  cache.set(key, A);
  return A;
}

/**
 * The whole library at once. Cached because it scans every message row twice —
 * about two seconds on a 700k-message database, which is fine once and far too
 * slow on every visit to the page you land on. invalidate() clears it along
 * with everything else when names or the snapshot change.
 */
function overviewData() {
  const d = getDb();
  if (!d) return null;
  if (cache.has("overview")) return cache.get("overview");
  const { names, canonical } = identities();
  const O = overview(d, { names, canonical });
  cache.set("overview", O);
  return O;
}

/** Full-text search inside one conversation, with surrounding messages. */
function search(chatId, { q, merge, mergeIds, who, from, to, limit = 60, context = 2 }) {
  const d = getDb();
  if (!d || !q) return { hits: [], total: 0 };
  const { names, canonical } = identities();
  const resolved = resolveChats(d, { chatId, merge, mergeIds, canonical });
  if (!resolved) return { hits: [], total: 0 };
  const meName = resolveMe(d, resolved.ids, { names, canonical });
  const { msgs } = loadMessages(d, resolved.ids, { names, canonical, meName });

  const needle = q.toLowerCase();
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) + 86_400_000 : Infinity;
  const hits = [];
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (m.ms < fromMs || m.ms > toMs) continue;
    if (who && m.who !== who) continue;
    if (!m.text.toLowerCase().includes(needle)) continue;
    hits.push({
      i, who: m.who, ms: m.ms, text: m.text,
      before: msgs.slice(Math.max(0, i - context), i).map((x) => ({ who: x.who, ms: x.ms, text: x.text })),
      after: msgs.slice(i + 1, i + 1 + context).map((x) => ({ who: x.who, ms: x.ms, text: x.text })),
    });
  }
  // Monthly histogram over all hits, so the chart reflects the search not the page.
  const byMonth = {};
  for (const h of hits) {
    const k = new Date(h.ms).toISOString().slice(0, 7);
    byMonth[k] = (byMonth[k] ?? 0) + 1;
  }
  const byPerson = {};
  for (const h of hits) byPerson[h.who] = (byPerson[h.who] ?? 0) + 1;
  return { total: hits.length, byMonth, byPerson, hits: hits.slice(-limit).reverse() };
}

/** Messages around a moment — for clicking into a peak day or a stat. */
function around(chatId, { at, merge, mergeIds, span = 40 }) {
  const d = getDb();
  if (!d) return { msgs: [] };
  const { names, canonical } = identities();
  const resolved = resolveChats(d, { chatId, merge, mergeIds, canonical });
  if (!resolved) return { msgs: [] };
  const meName = resolveMe(d, resolved.ids, { names, canonical });
  const { msgs } = loadMessages(d, resolved.ids, { names, canonical, meName });
  const target = Date.parse(at);
  if (!Number.isFinite(target)) return { msgs: [] };
  let idx = 0;
  for (let i = 0; i < msgs.length; i += 1) if (msgs[i].ms <= target) idx = i;
  return {
    msgs: msgs.slice(Math.max(0, idx - Math.floor(span / 2)), idx + Math.ceil(span / 2))
      .map((m) => ({ who: m.who, ms: m.ms, text: m.text })),
  };
}

/* ---------------- the assistant ---------------- */

const AI_SYSTEM = `You are analysing one iMessage conversation for the person who owns it.
You are given computed statistics, not raw message history — so ground every claim in the
numbers you were given and never invent a quote, a name, or a figure.

What good looks like:
- Lead with the two or three findings that actually land. Don't reformat the table back.
- Say what a number means about these people, not just what it is.
- Call out artifacts rather than reporting them straight: object-replacement characters are
  attachments, not text; "don" is "don't" losing its apostrophe; URL slugs and tracking
  parameters are not words; in a small group the most-reacted ranking is mostly noise.
- If the data doesn't support an answer, say so plainly instead of guessing.
Be specific and be funny where the data is funny. Skip preamble.

Answer the whole question. If it asks about the people in the chat, cover every
one of them rather than the first few — a partial list is a wrong answer.`;

/**
 * Tone presets. Each is appended to AI_SYSTEM; the grounding rules above always
 * survive, so no preset can license inventing a number to land a joke.
 *
 * "facts" is first because it is the honest default for reading statistics; the
 * rest exist because the same numbers are much funnier read aloud by someone
 * with an attitude, which is most of the point of the feature.
 */
const TONES = {
  facts: {
    label: "Facts only",
    prompt: "Tone: plain and analytical. No jokes, no editorialising, no nicknames. Report what the numbers show and what it means. Short sentences.",
  },
  funny: {
    label: "Funny",
    prompt: "Tone: genuinely funny — the comedy comes from the numbers being absurd, not from you announcing that they are. Warm, never punching down. Land a joke per finding and move on.",
  },
  roast: {
    label: "Roasting",
    prompt: "Tone: roast them. Affectionate but merciless, the way close friends actually talk to each other. Every burn must be anchored to a real statistic — the number is the punchline. These are the user's friends and family, so keep it the kind of thing you'd say to their face.",
  },
  mean: {
    label: "Mean",
    prompt: "Tone: blunt and unsparing. Say the uncomfortable thing the numbers imply — who has drifted, who talks past everyone, who nobody answers. Stay factual rather than cruel for its own sake, and never comment on anything the statistics don't actually show.",
  },
  sarcastic: {
    label: "Sarcastic",
    prompt: "Tone: dry and deadpan. Understatement, faint praise, the occasional raised eyebrow. Let the numbers do the damage while you sound unimpressed.",
  },
  silly: {
    label: "Silly",
    prompt: "Tone: playful and a bit unhinged. Extended metaphors, absurd comparisons, chaotic energy — but the underlying claims still have to be true.",
  },
  sportscaster: {
    label: "Sportscaster",
    prompt: "Tone: live sports commentary. Treat the chat like a season, the people like players, the stats like a box score. Rankings, records, breakout performances, slumps.",
  },
  therapist: {
    label: "Therapist",
    prompt: "Tone: gentle and observational, like someone noticing patterns out loud. Curious about what the rhythms suggest, careful not to diagnose. No jargon.",
  },
};

/** A compact, quote-light brief. Aggregates first; raw text only where it carries the point. */
function brief(A, { search } = {}) {
  const L = [];
  const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);

  L.push(`CHAT: ${A.chat.name} — ${A.total} messages, ${A.people.length} people, ${d(A.first)} → ${d(A.last)} (${A.spanDays} days, ${A.perDay.toFixed(1)}/day)`);
  if (A.aka?.length) L.push(`Also known as: ${A.aka.join(", ")}`);
  if (A.chat.ids.length > 1) L.push(`Merged from threads ${A.chat.ids.join(", ")}${A.rostersDiffer ? " (rosters differ — see per-year columns)" : ""}`);

  L.push(`\nPER PERSON (total, share, then by year ${A.years.join("/")}):`);
  for (const p of A.perPerson) {
    L.push(`  ${p.who}: ${p.n} (${pc(p.n, A.total)}) · ${A.years.map((y) => p.byYear[y] ?? 0).join("/")}` +
      ` · avg ${p.avgLen.toFixed(1)} chars · peak ${String(p.peakHour).padStart(2, "0")}:00` +
      ` · starts ${p.starts} · last-word ${p.lastWord} · median reply ${Math.round(p.medianReply / 1000)}s` +
      ` · double-texts ${pc(p.doubles, p.n)} · laughs ${pc(p.laughs, p.n)} · questions ${pc(p.questions, p.n)}` +
      ` · links ${p.links} · vocab ${p.vocab}` +
      (A.tapbacks ? ` · tapbacks given ${p.given}/got ${p.received}` : ""));
  }

  const B = A.busiest;
  L.push(`\nRHYTHM: busiest day ${B.day.key} (${B.day.n}) · busiest month ${B.month.key} (${B.month.n})` +
    ` · longest streak ${B.streak.days}d · active ${B.activeDays}/${A.spanDays} days`);
  L.push(`  hour-of-day: ${A.rhythm.hours.map((n, h) => `${h}h:${n}`).join(" ")}`);
  L.push(`  day-of-week: ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((x, i) => `${x}:${A.rhythm.dow[i]}`).join(" ")}`);
  if (B.silence) L.push(`  longest silence ${(B.silence.ms / 86400000).toFixed(1)}d after ${B.silence.after.who} on ${d(B.silence.after.ms)}: "${B.silence.after.text.slice(0, 120)}"`);

  L.push(`\nDYNAMICS: longest monologue ${A.dynamics.monologue.n} by ${A.dynamics.monologue.who}`);
  if (A.dynamics.fastest) L.push(`  fastest reply ${(A.dynamics.fastest.ms / 1000).toFixed(1)}s — ${A.dynamics.fastest.to.who}: "${A.dynamics.fastest.to.text.slice(0, 90)}" → ${A.dynamics.fastest.reply.who}: "${A.dynamics.fastest.reply.text.slice(0, 90)}"`);
  if (A.people.length > 2) for (const r of A.dynamics.matrix)
    L.push(`  ${r.who} replies to: ${A.people.filter((b) => b !== r.who).map((b) => `${b} ${r.to[b] == null ? "—" : Math.round(r.to[b] / 1000) + "s"}`).join(", ")}`);

  if (A.tapbacks) L.push(`\nTAPBACKS: ${A.tapbacks.total} total — ${A.tapbacks.kinds.map((k) => `${k.kind} ${k.n}`).join(", ")}`);

  L.push(`\nSIGNATURE WORDS (said far more than everyone else; min ${A.signature.minUses} uses):`);
  for (const s of A.signature.people)
    L.push(`  ${s.who}: ${s.words.map((w) => `${w.word} ${w.n}x ${w.ratio == null ? "(only them)" : w.ratio.toFixed(1) + "x"}`).join(", ")}`);

  L.push(`\nMOST-USED WORDS:`);
  for (const p of A.perPerson) if (p.topWords.length) L.push(`  ${p.who}: ${p.topWords.map((w) => `${w.word} (${w.n})`).join(", ")}`);

  if (A.emoji.overall.length) {
    L.push(`\nEMOJI overall: ${A.emoji.overall.map((e) => `${e.emoji} ${e.n}`).join("  ")}`);
    for (const p of A.perPerson) if (p.topEmoji.length) L.push(`  ${p.who}: ${p.topEmoji.map((e) => `${e.emoji} ${e.n}`).join("  ")}`);
  }

  L.push(`\nLONGEST MESSAGE: ${A.longest.len} chars by ${A.longest.who}, ${d(A.longest.ms)}: "${A.longest.text.slice(0, 300)}"`);
  if (A.odds.domains.length) L.push(`DOMAINS: ${A.odds.domains.map((x) => `${x.domain} ${x.n}`).join(", ")}`);
  L.push(`MOST-REPEATED MESSAGES: ${A.odds.repeated.map((r) => `"${r.text}" x${r.n}`).join(", ")}`);
  if (A.tapbacks?.mostReacted.length)
    L.push(`MOST-REACTED: ${A.tapbacks.mostReacted.map((r) => `${r.n}x ${r.msg.who} "${r.msg.text.slice(0, 60)}"`).join(" | ")}`);

  if (search?.total) {
    L.push(`\nSEARCH "${search.q}" — ${search.total} matches; by person ${JSON.stringify(search.byPerson)}`);
    L.push(`  by month: ${Object.entries(search.byMonth).map(([k, v]) => `${k}:${v}`).join(" ")}`);
    L.push(`  sample matches:`);
    for (const h of search.hits.slice(0, 25)) L.push(`    ${d(h.ms)} ${h.who}: ${h.text.slice(0, 160)}`);
  }
  return L.join("\n");
}

async function aiAsk({ chatId, merge, mergeIds, question, searchFor, tone }) {
  const cfg = loadAiConfig(DATA);
  if (cfg.error) throw new Error(cfg.error);
  if (!cfg.configured) throw new Error("The assistant is not configured. Create ai.local.json.");
  const A = chatDetail(chatId, { merge, mergeIds, top: 12 });
  if (!A || A.error) throw new Error(A?.error ?? `no chat ${chatId}`);
  // Only run a search when the caller asks for one — it re-reads every message.
  const s = searchFor ? { q: searchFor, ...search(chatId, { q: searchFor, merge, mergeIds, limit: 25 }) } : null;
  const context = brief(A, { search: s });
  const preset = TONES[tone] ?? TONES.funny;
  const { text, truncated } = await llmAsk(cfg, {
    system: `${AI_SYSTEM}\n\n${preset.prompt}`,
    user: `${context}\n\n---\nQUESTION: ${question}`,
    // A question like "assign everyone a character" wants a paragraph per
    // person, and a big group ran past 4096 and stopped mid-word. The ceiling
    // is only a cost cap — a cut-off answer costs the same and is worthless.
    maxTokens: 16384,
    logDir: DATA,
  });
  return {
    answer: text, truncated, tone, toneLabel: preset.label,
    provider: cfg.label, model: cfg.model, local: cfg.local,
    chat: A.chat.name, contextChars: context.length,
  };
}

/* ---------------- http ---------------- */

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

const send = (res, code, body, type = "application/json") => {
  const buf = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    "content-type": type,
    "content-length": Buffer.byteLength(buf),
    // This page must never be embedded or fetched by anything else.
    "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // Without this, browsers cache heuristically and keep serving the old UI
    // after `git pull` has already replaced it — the update silently doesn't
    // arrive. Nothing here is worth caching anyway: it is all local and cheap.
    "cache-control": "no-store",
  });
  res.end(buf);
};

const nums = (s) => (s ?? "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);

const server = createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://127.0.0.1"); } catch { return send(res, 400, { error: "bad url" }); }
  const p = url.pathname;
  const qs = url.searchParams;

  try {
    if (p === "/" || p === "/index.html") {
      const file = path.join(HERE, "ui", "index.html");
      if (!existsSync(file)) return send(res, 500, "ui/index.html is missing", "text/plain");
      return send(res, 200, readFileSync(file), TYPES[".html"]);
    }
    if (p === "/api/ping") return send(res, 200, { ok: true });
    if (p === "/api/status") return send(res, 200, status());
    if (p === "/api/ai") {
      const cfg = loadAiConfig(DATA);
      return send(res, 200, {
        ...cfg, key: undefined,   // never echo the key back to the browser
        providers: Object.entries(PROVIDERS).map(([id, v]) =>
          ({ id, label: v.label, local: v.local, needsKey: v.needsKey, hint: v.hint })),
        tones: Object.entries(TONES).map(([id, t]) => ({ id, label: t.label })),
      });
    }
    // Read a JSON body, then hand it to `fn` which returns a promise.
    const withBody = (fn) => {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on("end", () => {
        let q; try { q = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "bad json" }); }
        fn(q).then((r) => send(res, 200, r)).catch((e) => send(res, 400, { error: e.message }));
      });
    };

    // Ask the provider what it has, so nobody types a model id from memory.
    if (p === "/api/ai/models" && req.method === "POST") {
      return withBody(async (q) => {
        const preset = PROVIDERS[q.provider];
        if (!preset) throw new Error(`unknown provider "${q.provider}"`);
        const key = q.apiKey || (preset.keyEnv ? process.env[preset.keyEnv] : null) || null;
        if (preset.needsKey && !key) throw new Error(`${preset.label} needs an API key first`);
        const baseUrl = q.baseUrl || preset.baseUrl;
        if (!baseUrl) throw new Error("this provider needs a baseUrl");
        return { models: await listModels({ ...preset, baseUrl, key }) };
      });
    }

    // Write ai.local.json so setup can happen entirely in the browser.
    if (p === "/api/ai/config" && req.method === "POST") {
      return withBody(async (q) => {
        // Turning the assistant off again has to be possible from the UI, or the
        // only way back is editing ai.local.json by hand.
        if (q.clear) {
          const f = path.join(DATA, "ai.local.json");
          if (existsSync(f)) unlinkSync(f);
          return { ok: true, cleared: true };
        }
        const preset = PROVIDERS[q.provider];
        if (!preset) throw new Error(`unknown provider "${q.provider}"`);
        if (!q.model) throw new Error("pick a model");
        const cfg = { provider: q.provider, model: q.model };
        if (q.baseUrl) cfg.baseUrl = q.baseUrl;
        // Only persist a key we were actually handed — an env-var key stays in the env.
        if (q.apiKey) cfg.apiKey = q.apiKey;
        writeFileSync(path.join(DATA, "ai.local.json"), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
        const saved = loadAiConfig(DATA);
        if (saved.error) throw new Error(saved.error);
        return { ok: true, label: saved.label, model: saved.model, local: saved.local };
      });
    }

    if (p === "/api/ai/ask" && req.method === "POST") {
      return withBody((q) => aiAsk({
        chatId: Number(q.chatId), merge: Boolean(q.merge), mergeIds: q.ids ?? [],
        question: String(q.question ?? "").slice(0, 4000), searchFor: q.search || null,
        tone: q.tone || null,
      }));
    }
    if (p === "/api/source") {
      return messagesRunning().then((running) => send(res, 200, { ...source(), messagesRunning: running }));
    }
    if (p === "/api/import" && req.method === "POST") {
      return importSnapshot().then((r) => send(res, r.ok ? 200 : 400, r))
        .catch((e) => send(res, 500, { ok: false, error: e.message }));
    }
    if (p === "/api/overview") {
      const O = overviewData();
      return O ? send(res, 200, O) : send(res, 404, { error: "no database yet" });
    }
    if (p === "/api/chats") return send(res, 200, chats({ min: Number(qs.get("min") ?? 1), limit: Number(qs.get("limit") ?? 400) }));

    const m = p.match(/^\/api\/chat\/(\d+)(\/search|\/around)?$/);
    if (m) {
      const id = Number(m[1]);
      const opts = { merge: qs.get("merge") === "1", mergeIds: nums(qs.get("ids")) };
      if (m[2] === "/search") {
        return send(res, 200, search(id, {
          ...opts, q: qs.get("q") ?? "", who: qs.get("who") || null,
          from: qs.get("from") || null, to: qs.get("to") || null,
        }));
      }
      if (m[2] === "/around") return send(res, 200, around(id, { ...opts, at: qs.get("at") }));
      const detail = chatDetail(id, { ...opts, top: Number(qs.get("top") ?? 10) });
      return detail ? send(res, 200, detail) : send(res, 404, { error: `no chat ${id}` });
    }

    if (p === "/api/build-names" && req.method === "POST") {
      // cwd is the data directory, not HERE: resolveNamesPath() probes cwd for
      // a legacy names.json before falling back to the data dir, so running the
      // child inside the clone made that probe find — and keep rewriting — a
      // copy in code that git pull replaces wholesale.
      return execFile(process.execPath, [path.join(HERE, "build-names.mjs"), "--write"], { cwd: dataDir() },
        (err, stdout, stderr) => {
          invalidate();
          send(res, err ? 500 : 200, { ok: !err, output: `${stdout}${stderr}`.trim() });
        });
    }
    if (p === "/api/open-privacy" && req.method === "POST") {
      // Full Disk Access is the one permission with no request API — nothing
      // can make the prompt appear, so the best available is jumping straight
      // to the pane the user has to toggle by hand.
      //
      // Deliberately takes no URL. An endpoint that opens whatever it is given
      // is a hole: any page in any browser can POST to a loopback server, and
      // this one would hand it a URL launcher. The destination is fixed here.
      const pane = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
      return execFile("/usr/bin/open", [pane], (err) =>
        send(res, err ? 500 : 200, { ok: !err, error: err ? err.message : null }));
    }
    if (p === "/api/reload" && req.method === "POST") {
      invalidate();
      if (db) { db.close(); db = null; }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

// Loopback only. Not 0.0.0.0 — this serves your entire message history.
server.listen(PORT, "127.0.0.1", () => {
  const ok = existsSync(DB_PATH);
  console.log(`\n  MessageStats  →  \x1b[1mhttp://127.0.0.1:${PORT}\x1b[0m`);
  console.log(`  database  ${ok ? DB_PATH : "not found yet — the page will walk you through it"}`);
  console.log(`  names     ${existsSync(NAMES_PATH) ? NAMES_PATH : "none yet"}`);
  console.log(`\n  Loopback only. Nothing is uploaded. Ctrl-C to stop.\n`);
});
