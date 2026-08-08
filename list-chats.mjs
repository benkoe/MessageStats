/**
 * List conversations so you can pick one. METADATA ONLY.
 *
 *   node list-chats.mjs
 *   node list-chats.mjs --min 500
 *   node list-chats.mjs --search "cuscrise"
 *   node list-chats.mjs --db /path/to/chat.db
 *
 * No message text is read here — not as a preview, not truncated, not at
 * all. That is structural rather than a promise: every SELECT below names
 * its columns, none of them names `text` or `attributedBody`, and this file
 * does not import messageText. Pick a ROWID, then run stats.mjs on it.
 *
 * Contact names are NOT in chat.db — they live in the AddressBook database,
 * which this tool never touches. So people show as phone numbers and emails
 * unless you supply a names.json (see README).
 */

import {
  appleMicrosToMs, arg, chatSummaries, DATE_TO_MICROS, findSameNameChats,
  findSiblingChats, loadIdentities, normalizeHandle, openDb, pad, padL,
  REAL_MESSAGE_WHERE, resolveDbPath,
} from "./lib.mjs";

const argv = process.argv.slice(2);
const minCount = Number(arg(argv, "min") ?? 1);
const limit = Number(arg(argv, "limit") ?? 60);
const search = (arg(argv, "search") ?? "").toLowerCase();
const { names, canonical } = loadIdentities(arg(argv, "names") ?? "names.json");

let db;
try {
  db = openDb(resolveDbPath(argv));
} catch (err) {
  // The message here is the setup instructions — a stack trace on top of
  // them just buries the thing the reader needs.
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

const chats = db
  .prepare(
    `select c.ROWID rowid, c.display_name display_name,
            c.chat_identifier chat_identifier, c.style style,
            count(m.ROWID) msg_count,
            min(${DATE_TO_MICROS.replace("date", "m.date")}) first_us,
            max(${DATE_TO_MICROS.replace("date", "m.date")}) last_us
       from chat c
       join chat_message_join cmj on cmj.chat_id = c.ROWID
       join message m on m.ROWID = cmj.message_id
      where ${REAL_MESSAGE_WHERE}
      group by c.ROWID
     having count(m.ROWID) >= ?
      order by msg_count desc
      limit ?`
  )
  .all(minCount, limit);

const handlesFor = db.prepare(
  `select h.id id from chat_handle_join chj
     join handle h on h.ROWID = chj.handle_id
    where chj.chat_id = ? order by h.id`
);

const label = (h) => names.get(canonical(normalizeHandle(h))) ?? h;
const shortDate = (us) => {
  const ms = appleMicrosToMs(us);
  return ms ? new Date(ms).toISOString().slice(0, 10) : "—";
};

const rows = chats.filter((c) => {
  if (!search) return true;
  const people = [...new Set(handlesFor.all(c.rowid).map((h) => label(h.id)))].join(" ");
  return `${c.display_name ?? ""} ${c.chat_identifier ?? ""} ${people}`
    .toLowerCase()
    .includes(search);
});

if (!rows.length) {
  console.log("\nNo conversations matched. Try a lower --min or a different --search.\n");
  process.exit(0);
}

// Snapshot age up front: every "lately" conclusion depends on it, and the
// copy is a point-in-time snapshot that quietly goes stale.
const newestUs = Math.max(...rows.map((c) => c.last_us ?? 0));
const newestMs = appleMicrosToMs(newestUs);
const ageH = newestMs ? (Date.now() - newestMs) / 3_600_000 : null;
const age = ageH == null ? "unknown"
  : ageH < 24 ? `${ageH.toFixed(1)}h old`
  : `${Math.round(ageH / 24)} days old — consider re-copying chat.db`;
console.log(
  `\n${rows.length} conversation(s), busiest first. Metadata only — no message text is read.` +
    `\nSnapshot: newest message ${newestMs ? new Date(newestMs).toISOString().slice(0, 16).replace("T", " ") : "?"} (${age})\n`
);
// Same people, several chat rows. Metadata only — see findSiblingChats.
const siblings = findSiblingChats(db, canonical);
// Looser tier: same name, different roster. Reported, never auto-merged.
const sameName = findSameNameChats(db, canonical);
const sibSummary = chatSummaries(
  db,
  rows.flatMap((c) => [...(siblings.get(c.rowid) ?? []), ...(sameName.get(c.rowid) ?? [])])
);
const liveOnly = (ids, self) =>
  (ids ?? []).filter((id) => id !== self && (sibSummary.get(id)?.n ?? 0) > 0);
const siblingsOf = (rowid) => liveOnly(siblings.get(rowid), rowid);
const sameNameOf = (rowid) =>
  liveOnly(sameName.get(rowid), rowid).filter((id) => !siblingsOf(rowid).includes(id));
let splitCount = 0;
let churnCount = 0;

console.log(
  `${pad("ROWID", 7)}${padL("MSGS", 8)}  ${pad("FIRST", 12)}${pad("LAST", 12)}${pad("KIND", 7)}NAME / PEOPLE`
);
console.log("─".repeat(104));

for (const c of rows) {
  // Deduped: two handles belonging to one person (see aliases) would
  // otherwise print that person's name twice.
  const people = [...new Set(handlesFor.all(c.rowid).map((h) => label(h.id)))];
  const kind = c.style === 43 ? "group" : "1:1";
  const name =
    c.display_name?.trim() ||
    (kind === "1:1" ? people[0] ?? c.chat_identifier ?? "?" : "(unnamed group)");
  console.log(
    `${pad(c.rowid, 7)}${padL(c.msg_count.toLocaleString(), 8)}  ` +
      `${pad(shortDate(c.first_us), 12)}${pad(shortDate(c.last_us), 12)}${pad(kind, 7)}${name}`
  );
  if (kind === "group") {
    const roster = people.length > 8
      ? `${people.slice(0, 8).join(", ")} +${people.length - 8} more`
      : people.join(", ");
    console.log(`${" ".repeat(7)}${people.length} people: ${roster}`);
  }
  // The same conversation living in more than one chat row. Worth shouting
  // about: the row above is not the whole history with these people.
  const sibs = siblingsOf(c.rowid);
  if (sibs.length) {
    splitCount += 1;
    const extra = sibs.reduce((s, id) => s + sibSummary.get(id).n, 0);
    const share = (extra / (c.msg_count + extra)) * 100;
    console.log(
      `${" ".repeat(7)}\x1b[33m⚠ split across ${sibs.length + 1} threads\x1b[0m — ` +
        `also ${sibs.map((id) => `${id} (${sibSummary.get(id).n.toLocaleString()})`).join(", ")}` +
        `  ·  ${share < 0.05 ? "<0.1" : share.toFixed(1)}% of this conversation is NOT in ${c.rowid}`
    );
  }
  // Same name, different roster — a group with people joining and leaving,
  // or a deliberately separate chat. Only a human can tell which.
  const churn = sameNameOf(c.rowid);
  if (churn.length) {
    churnCount += 1;
    const extra = churn.reduce((s, id) => s + sibSummary.get(id).n, 0);
    console.log(
      `${" ".repeat(7)}\x1b[33m? same name, different roster\x1b[0m — ` +
        `also ${churn.map((id) => `${id} (${sibSummary.get(id).n.toLocaleString()})`).join(", ")}` +
        `  ·  ${extra.toLocaleString()} msgs, NOT merged automatically`
    );
  }
}

if (splitCount || churnCount) {
  if (splitCount) {
    console.log(
      `\n\x1b[33m⚠ ${splitCount} conversation(s) are split across several chat rows.\x1b[0m` +
        `\nSame people, different chat_identifier — a recreated group, an SMS/iMessage` +
        `\nsplit, or a rename. Safe to fold together:` +
        `\n\n  node stats.mjs --chat <ROWID> --merge`
    );
  }
  if (churnCount) {
    console.log(
      `\n\x1b[33m? ${churnCount} conversation(s) share a name with a differently-staffed thread.\x1b[0m` +
        `\nA work group with people joining and leaving looks identical to a chat that` +
        `\ndeliberately excludes someone, so these are never merged for you. If you know` +
        `\nit is one group, name the rows:` +
        `\n\n  node stats.mjs --chat <ROWID> --merge <ROWID,ROWID,...>`
    );
  }
  console.log();
} else {
  console.log(`\nThen:  node stats.mjs --chat <ROWID>\n`);
}
db.close();
