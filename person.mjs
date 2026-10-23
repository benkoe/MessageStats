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
