/**
 * One person across every conversation they are in.
 *
 * The chat report asks "what happened in this thread"; this asks "what is
 * this person like", which means their 1:1 thread *and* every group they
 * have sent a message in, read side by side. The data layer is here; the
 * per-person numbers and the excerpt selection are in analyze.mjs, shared
 * with the chat report so the two can never disagree about a thread.
 *
 * A person is keyed by canonical handle (URLs, API, caches) and their
 * messages are selected by the display name it resolves to — which is how
 * every other stat in the app is keyed. Two handles that share a name without
 * an alias are one `who` and two handles; that is the split-identity trap
 * Settings warns about, and this inherits it rather than fixing it.
 */
import {
  appleMicrosToMs, chatSummaries, DATE_TO_MICROS, findSiblingChats, isShortcode,
  normalizeHandle, REAL_MESSAGE_WHERE,
} from "./lib.mjs";

/**
 * Everyone who has ever sent a message, busiest first.
 *
 * One grouped query — no text is read — folded in JS by canonical handle so
 * an iCloud address and a phone number with an alias count once. Outgoing
 * rows have no handle_id and are not here: this is a list of other people.
 * Shortcodes are vending machines, not people. Two canonical handles that
 * resolve to the same name fold into the busier one: a split identity is
 * still one person on this list, and the name is what selects messages.
 */
export function peopleDirectory(db, { names, canonical }) {
  const rows = db.prepare(
    `select h.id hid, j.chat_id cid, count(*) n,
            min(${DATE_TO_MICROS.replace("date", "m.date")}) first_us,
            max(${DATE_TO_MICROS.replace("date", "m.date")}) last_us
       from message m
       join chat_message_join j on j.message_id = m.ROWID
       join handle h on h.ROWID = m.handle_id
      where ${REAL_MESSAGE_WHERE}
      group by h.id, j.chat_id`
  ).all();

  const byHandle = new Map();
  for (const r of rows) {
    if (isShortcode(r.hid)) continue;
    const handle = canonical(normalizeHandle(r.hid));
    if (!handle) continue;
    let p = byHandle.get(handle);
    if (!p) {
      p = { handle, name: names.get(handle) ?? r.hid, n: 0, chats: new Set(), first: Infinity, last: -Infinity, raw: new Set() };
      byHandle.set(handle, p);
    }
    p.n += r.n;
    p.chats.add(r.cid);
    p.raw.add(r.hid);
    p.first = Math.min(p.first, appleMicrosToMs(r.first_us));
    p.last = Math.max(p.last, appleMicrosToMs(r.last_us));
  }

  // Same name, different canonical handle, no alias: fold under the busier.
  const byName = new Map();
  for (const p of [...byHandle.values()].sort((a, b) => b.n - a.n)) {
    const have = byName.get(p.name);
    if (!have) { byName.set(p.name, p); continue; }
    have.n += p.n;
    for (const c of p.chats) have.chats.add(c);
    for (const h of p.raw) have.raw.add(h);
    have.first = Math.min(have.first, p.first);
    have.last = Math.max(have.last, p.last);
  }
  return [...byName.values()].sort((a, b) => b.n - a.n).map((p) => ({
    handle: p.handle, name: p.name, n: p.n, chats: [...p.chats].sort((a, b) => a - b),
    first: p.first, last: p.last, aka: [...p.raw],
  }));
}

/**
 * The conversations one person is in, folded the way the app folds them.
 *
 * "In" means they sent a message there — not `chat_handle_join`, which drops
 * anyone who left a group while their messages remain. Rows fold by strict
 * siblings (same people or the same original_group_id) when `combine` is on,
 * and by the decisions in merges.local.json either way: a same-name thread
 * the user said is the same conversation must not show twice here with its
 * numbers split, which is the two-frontends-disagreeing bug through another
 * door. Dismissed ids are the other answer to that question and are never
 * pulled in.
 *
 * The floor keeps one stray message in a 60k-message group from costing a
 * full scan of that group: threads below it are counted in `others`, not
 * loaded. The anchor id is the busiest row by total messages — the sidebar's
 * rule — and it names the thread.
 */
export function personThreads(db, { handle, canonical, names, merges = {}, combine = true, floor = 10 }) {
  const rows = db.prepare(
    `select h.id hid, j.chat_id cid, count(*) n
       from message m
       join chat_message_join j on j.message_id = m.ROWID
       join handle h on h.ROWID = m.handle_id
      where ${REAL_MESSAGE_WHERE}
      group by h.id, j.chat_id`
  ).all();
  const mine = new Map();   // chat id -> messages from them
  let raw = null;
  for (const r of rows) {
    if (canonical(normalizeHandle(r.hid)) !== handle) continue;
    mine.set(r.cid, (mine.get(r.cid) ?? 0) + r.n);
    raw ??= r.hid;
  }
  if (!mine.size) return { threads: [], others: 0 };

  // Union-find over chat ids: strict siblings, then remembered decisions.
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => { const [ra, rb] = [find(a), find(b)]; if (ra !== rb) parent.set(ra, rb); };
  for (const id of mine.keys()) find(id);
  const sib = findSiblingChats(db, canonical);
  const foldSiblings = (id) => { for (const s of sib.get(id) ?? []) union(id, s); };
  if (combine) for (const id of mine.keys()) foldSiblings(id);
  for (const [key, m] of Object.entries(merges ?? {})) {
    const id = Number(key);
    if (!Number.isFinite(id) || !m || typeof m !== "object") continue;
    const dismissed = new Set((m.dismissed ?? []).map(Number));
    // Explicit ids answer the same-name question and fold in regardless;
    // `merge` says the strict siblings should too, preference or not.
    for (const x of (m.ids ?? []).map(Number)) if (x && !dismissed.has(x)) union(id, x);
    if (m.merge) foldSiblings(id);
  }

  const groups = new Map();   // root -> Set of ids
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root).add(id);
  }
  const relevant = [...groups.values()].filter((set) => [...set].some((id) => mine.has(id)));
  const all = [...new Set(relevant.flatMap((set) => [...set]))];
  const totals = chatSummaries(db, all);
  const holes = all.map(() => "?").join(",");
  const meta = new Map(db.prepare(
    `select ROWID id, display_name dn, chat_identifier ci, style from chat where ROWID in (${holes})`
  ).all(...all).map((c) => [c.id, c]));

  const threads = relevant.map((set) => {
    const ids = [...set].filter((id) => meta.has(id)).sort((a, b) => a - b);
    let anchor = ids[0];
    for (const id of ids) if ((totals.get(id)?.n ?? 0) > (totals.get(anchor)?.n ?? 0)) anchor = id;
    const c = meta.get(anchor);
    const isGroup = c.style === 43;
    const name = c.dn?.trim() || (isGroup ? "(unnamed group)" : names.get(handle) ?? raw);
    return {
      id: anchor, ids: [anchor, ...ids.filter((id) => id !== anchor)], name, isGroup,
      n: ids.reduce((s, id) => s + (mine.get(id) ?? 0), 0),
    };
  }).sort((a, b) => Number(a.isGroup) - Number(b.isGroup) || b.n - a.n || a.id - b.id);

  return {
    threads: threads.filter((t) => t.n >= floor),
    others: threads.filter((t) => t.n < floor).length,
  };
}
