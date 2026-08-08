/**
 * Shared plumbing for the iMessage stats tools.
 *
 * Plain ESM, zero dependencies. SQLite comes from node:sqlite (built in on
 * Node 22.5+ behind a flag, stable on 24+), so there is nothing to npm
 * install and nothing to keep up to date.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/* ---------------- database ---------------- */

/**
 * Where MessageStats keeps YOUR data — the database copy, names.json, the
 * assistant config. Deliberately NOT the repo: the repo is code, and code gets
 * replaced wholesale by `git pull` on every launch. Anything of yours living
 * next to the scripts would be one bad merge away from being lost, and would
 * make your checkout differ from everyone else's.
 *
 * Override with MESSAGESTATS_DATA for testing or a second profile.
 */
export function dataDir() {
  const custom = process.env.MESSAGESTATS_DATA;
  const dir = custom
    ? path.resolve(custom)
    : path.join(os.homedir(), "Library", "Application Support", "MessageStats");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The names file, in the data directory unless overridden. */
export function resolveNamesPath(argv) {
  const explicit = arg(argv, "names");
  if (explicit) return path.resolve(explicit);
  // A names.json sitting beside the scripts still wins, so an existing
  // checkout keeps working after this change.
  const legacy = path.resolve(process.cwd(), "names.json");
  if (existsSync(legacy)) return legacy;
  return path.join(dataDir(), "names.json");
}

export function resolveDbPath(argv) {
  const explicit = arg(argv, "db");
  if (explicit) return path.resolve(explicit);
  // Data directory first; then the legacy in-repo locations, so anyone who
  // already had a copy beside the scripts is not suddenly told to re-import.
  const candidates = [
    path.join(dataDir(), "chat.db"),
    path.resolve(process.cwd(), "Messages/chat.db"),
    path.resolve(process.cwd(), "chat.db"),
  ];
  for (const full of candidates) if (existsSync(full)) return full;
  return candidates[0];
}

export function openDb(dbPath) {
  if (!existsSync(dbPath)) {
    throw new Error(
      `No database at ${dbPath}\n\n` +
        `Quit Messages (Cmd-Q, not just close the window — otherwise recent\n` +
        `messages sit unflushed in the WAL), then copy these three files from\n` +
        `~/Library/Messages via Finder into this folder (or ./Messages/):\n` +
        `    chat.db   chat.db-wal   chat.db-shm\n\n` +
        `All three matter. chat.db alone opens fine and silently misses the\n` +
        `most recent messages.\n\n` +
        `Or pass --db /path/to/chat.db`
    );
  }
  // Read-only. It's a copy, but the copy is the only thing between a bug
  // here and the real message history.
  return new DatabaseSync(dbPath, { readOnly: true });
}

/* ---------------- time ---------------- */

/**
 * message.date is NANOSECONDS since the Apple epoch (2001-01-01) on modern
 * macOS — around 6.7e17, which is past Number.MAX_SAFE_INTEGER. Reading the
 * raw column into JS throws. Every query therefore divides it down in SQL;
 * dividing to MICROseconds stays inside safe-integer range and keeps more
 * precision than anything here needs.
 *
 * Very old databases (pre-High Sierra) stored SECONDS instead. This corpus
 * had none, but if dates come out in 2001 that's the reason.
 */
export const DATE_TO_MICROS = "date / 1000";
const APPLE_EPOCH_UNIX_SECONDS = 978_307_200;

export function appleMicrosToMs(micros) {
  if (micros == null || !Number.isFinite(micros) || micros === 0) return null;
  return micros / 1000 + APPLE_EPOCH_UNIX_SECONDS * 1000;
}

/* ---------------- message text ---------------- */

/**
 * THE MOST IMPORTANT FUNCTION HERE.
 *
 * On modern macOS the `text` column is usually NULL and the body lives in
 * `attributedBody` as an archived NSAttributedString. On the corpus this was
 * built against, only 7,724 of 890,482 rows (0.87%) had usable `text` — so a
 * tool that reads the text column alone reports near-zero for everybody and
 * looks merely disappointing rather than broken.
 *
 * The blob is a `streamtyped` archive (NSArchiver — NOT a plist and NOT
 * NSKeyedArchiver, so plist parsers return nothing). Around the body:
 *
 *     "NSString" … 0x2B <length> <utf8 bytes>
 *
 * 0x2B ('+') is the byte-string type code. Length is one byte under 128;
 * 0x81 means a uint16 LE follows, 0x82/0x83 a uint32 LE.
 *
 * Validated against ground truth: on all 7,724 rows carrying BOTH columns,
 * the extracted string matched `text` byte-for-byte. If you ever change this,
 * re-run that comparison — it is the only check that distinguishes a working
 * parser from one quietly returning the wrong substring.
 */
export function messageText(text, attributedBody) {
  if (text != null && text.length > 0) return text;
  if (!attributedBody) return null;

  const buf = Buffer.from(attributedBody);
  const marker = buf.indexOf("NSString", 0, "latin1");
  if (marker < 0) return null;

  // Scan a short window for the type code rather than hardcoding an offset,
  // which differs across macOS versions.
  const from = marker + "NSString".length;
  const limit = Math.min(from + 24, buf.length);
  let p = -1;
  for (let i = from; i < limit; i += 1) {
    if (buf[i] === 0x2b) { p = i + 1; break; }
  }
  if (p < 0 || p >= buf.length) return null;

  let len = buf[p];
  p += 1;
  if (len === 0x81) {
    if (p + 2 > buf.length) return null;
    len = buf.readUInt16LE(p); p += 2;
  } else if (len === 0x82 || len === 0x83) {
    if (p + 4 > buf.length) return null;
    len = buf.readUInt32LE(p); p += 4;
  } else if (len > 0x83) return null;

  if (len <= 0 || p + len > buf.length) return null;
  return buf.subarray(p, p + len).toString("utf8");
}

/**
 * Only associated_message_type = 0 is a message someone typed. 2000-2007 are
 * tapbacks and stickers being ADDED, 3000-3007 the same being removed — about
 * a fifth of a typical database. item_type != 0 is joins, renames and other
 * system rows.
 */
export const REAL_MESSAGE_WHERE =
  "m.associated_message_type = 0 and m.item_type = 0";

/* ---------------- identities ---------------- */

/** Fold a handle to a comparable key. Phones become digits, emails lowercase. */
export function normalizeHandle(handle) {
  const h = String(handle ?? "").trim();
  if (!h) return "";
  if (h.includes("@")) return h.toLowerCase();
  const digits = h.replace(/[^\d]/g, "");
  if (digits.length === 10) return `1${digits}`; // bare US number
  return digits;
}

/**
 * names.json gives people names, and merges the ones who have two handles.
 *
 * People change handles — someone messaging from an iCloud email while
 * travelling shows up as a second person with half their history. An ALIAS
 * folds one handle onto another so they count as one person everywhere.
 *
 * Both shapes work:
 *   { "(617) 555-0100": "Alice" }
 *   { "names":   { "(617) 555-0100": "Alice" },
 *     "aliases": { "alice@icloud.com": "(617) 555-0100" } }
 */
export function loadIdentities(file) {
  const names = new Map();
  const aliases = new Map();
  if (file && existsSync(file)) {
    let raw = {};
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      console.error(`  (couldn't read ${file}: ${err.message})`);
    }
    const nameSource =
      raw.names && typeof raw.names === "object"
        ? raw.names
        : Object.fromEntries(
            Object.entries(raw).filter(([k]) => k !== "names" && k !== "aliases")
          );
    for (const [h, n] of Object.entries(nameSource)) {
      names.set(normalizeHandle(h), String(n));
    }
    for (const [from, to] of Object.entries(raw.aliases ?? {})) {
      aliases.set(normalizeHandle(from), normalizeHandle(String(to)));
    }
  }
  const canonical = (key) => {
    let cur = key;
    for (let i = 0; i < 5; i += 1) {
      const next = aliases.get(cur);
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  };
  return { names, aliases, canonical };
}

/* ---------------- sibling threads ---------------- */

/**
 * iMessage keeps SEVERAL chat rows for what is socially one conversation.
 * A group gets recreated, an SMS thread splits off an iMessage one, someone
 * renames the group and a fresh chat_identifier is minted. Those rows then
 * look like unrelated conversations in list-chats, and analyzing only the
 * biggest one silently drops the rest.
 *
 * It is not a rounding error. In the corpus this was built against, one
 * two-person chat had 27% of its history in a second thread with a different
 * display name, and another had 37%. Nothing about the output looks wrong
 * when that happens — you just get confident numbers about three quarters of
 * a friendship.
 *
 * Two chats are siblings here if their CANONICAL participant sets are
 * identical, i.e. the same people once names.json aliases are folded in.
 * That is deliberately strict: a thread someone left, or was added to, is a
 * different set and will NOT match. Merging those would quietly change who
 * the conversation is about, which is worse than missing them.
 *
 * Reads chat_handle_join and handle only — no message rows, no text. That is
 * what lets list-chats.mjs call it without breaking its no-text guarantee.
 */
export function chatRosters(db, canonical) {
  const rows = db
    .prepare(
      `select chj.chat_id cid, h.id hid
         from chat_handle_join chj
         join handle h on h.ROWID = chj.handle_id`
    )
    .all();
  const sets = new Map();
  for (const r of rows) {
    if (!sets.has(r.cid)) sets.set(r.cid, new Set());
    sets.get(r.cid).add(canonical(normalizeHandle(r.hid)));
  }
  return sets;
}

export function findSiblingChats(db, canonical) {
  const sets = chatRosters(db, canonical);

  const groups = new Map();
  const add = (key, cid) => {
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cid);
  };

  // Signal 1: identical canonical roster.
  for (const [cid, members] of sets) {
    // Sorted join is the fingerprint. An empty one means no resolvable
    // handles, which tells us nothing — don't group those together.
    add(`r:${[...members].filter(Boolean).sort().join("|")}`, cid);
  }

  // Signal 2: chat.original_group_id — Apple's OWN identity for a group,
  // preserved when a thread is recreated, renamed, or falls back to SMS. It
  // is strictly better than guessing from the roster: it links a work group
  // across staff changes (rosters differ, same group) while never linking a
  // deliberately-separate chat that merely shares members. In this corpus it
  // ties 15 pairs together, two of which roster-matching alone misses, and it
  // correctly leaves the "W/O <name>" birthday-planning chats alone.
  for (const c of db
    .prepare(`select ROWID id, original_group_id ogid from chat where original_group_id is not null`)
    .all()) {
    add(`g:${c.ogid}`, c.id);
  }

  // A chat can be joined by either signal, so merge overlapping groups
  // transitively — union-find over the two keyings.
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const ids of groups.values()) {
    for (const id of ids) if (!parent.has(id)) parent.set(id, id);
    for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i]);
  }

  const merged = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!merged.has(root)) merged.set(root, []);
    merged.get(root).push(id);
  }

  const byChat = new Map();
  for (const ids of merged.values()) {
    if (ids.length < 2) continue;
    const sorted = [...ids].sort((a, b) => a - b);
    for (const id of sorted) byChat.set(id, sorted);
  }
  return byChat;
}

/**
 * The looser tier: chats sharing a display name whose rosters DIFFER but
 * overlap. A work group where people are added and removed as they join and
 * leave the company is one conversation socially, but each roster change can
 * mint a new chat row, so findSiblingChats() correctly refuses to touch it.
 *
 * This is REPORT-ONLY and must stay that way. Roster overlap on its own is a
 * terrible merge signal: in one real corpus a 42,856-message group had 86%
 * overlap with four small chats whose names all followed the pattern
 * "W/O <name>" — the group deliberately minus one person, for planning that
 * person's birthday. Merging on overlap would fold talking ABOUT someone into
 * talking WITH them. Requiring an identical display name filters that out,
 * but not reliably enough to act on unsupervised.
 *
 * So: surface these, name the roster difference, and let a human pass the
 * ids to --merge.
 *
 * Handles and names only — no message rows, no text.
 */
export function findSameNameChats(db, canonical) {
  const rosters = chatRosters(db, canonical);
  const chats = db
    .prepare(`select ROWID id, display_name dn from chat where display_name is not null`)
    .all();

  const byName = new Map();
  for (const c of chats) {
    const name = String(c.dn).trim().toLowerCase().replace(/\s+/g, " ");
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(c.id);
  }

  const byChat = new Map();
  for (const ids of byName.values()) {
    if (ids.length < 2) continue;
    const key = (id) => [...(rosters.get(id) ?? [])].filter(Boolean).sort().join("|");
    // Only interesting if the rosters actually differ — identical ones are
    // already strict siblings and handled without a human in the loop.
    if (new Set(ids.map(key)).size < 2) continue;
    // And only if they overlap at all: two unrelated groups both called
    // "Family" share a name and nothing else.
    const overlaps = ids.some((a) =>
      ids.some((b) => {
        if (a === b) return false;
        const A = rosters.get(a) ?? new Set();
        return [...(rosters.get(b) ?? [])].some((h) => A.has(h));
      })
    );
    if (!overlaps) continue;
    const sorted = [...ids].sort((a, b) => a - b);
    for (const id of sorted) byChat.set(id, sorted);
  }
  return byChat;
}

/**
 * Real-message count and date range for specific chats, as a Map keyed by
 * chat id. Metadata only: a COUNT and message.date, never text.
 */
export function chatSummaries(db, chatIds) {
  const out = new Map();
  const ids = [...new Set(chatIds ?? [])];
  if (!ids.length) return out;
  const holes = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `select j.chat_id cid, count(*) n,
              min(${DATE_TO_MICROS.replace("date", "m.date")}) first_us,
              max(${DATE_TO_MICROS.replace("date", "m.date")}) last_us
         from message m
         join chat_message_join j on j.message_id = m.ROWID
        where j.chat_id in (${holes}) and ${REAL_MESSAGE_WHERE}
        group by j.chat_id`
    )
    .all(...ids);
  for (const r of rows) out.set(r.cid, r);
  return out;
}

/* ---------------- args + formatting ---------------- */

export function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
export function flag(argv, name) {
  return argv.includes(`--${name}`);
}

export const pad = (s, n) => {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str.padEnd(n);
};
export const padL = (s, n) => String(s).padStart(n);

export function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

export function human(ms) {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function bar(n, max, width = 24) {
  if (!max || n <= 0) return "";
  return "█".repeat(Math.max(1, Math.round((n / max) * width)));
}

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function head(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log("─".repeat(Math.min(78, Math.max(34, title.length + 6))));
}

export function inc(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

export function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** One-line quote, trimmed and collapsed, for printing a message inline. */
export function quote(text, max = 150) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
