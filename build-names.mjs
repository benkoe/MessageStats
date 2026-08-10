/**
 * Fill in names.json from the macOS Contacts database.
 *
 *   node build-names.mjs                 # dry run — shows what it would write
 *   node build-names.mjs --write         # merge into names.json
 *   node build-names.mjs --write --all-chats
 *
 * Contacts live in their own SQLite databases under
 * ~/Library/Application Support/AddressBook — chat.db has no names in it at
 * all, which is why every unnamed person shows up as a phone number.
 *
 * Two things this does that a plain dump of your address book would not:
 *
 * 1. It only emits people who ACTUALLY APPEAR in your chats. Your address
 *    book has hundreds of contacts; a names.json listing all of them would
 *    be noise, and would put a pile of personal data in a file for no
 *    reason. Everyone written here is someone you have messaged.
 *
 * 2. It detects ALIASES. When one contact record owns two handles that both
 *    appear in your messages — a phone and an iCloud email, say — that
 *    person is currently being counted as two people with half their
 *    history each. This folds them together automatically, which is exactly
 *    the case that has to be found by hand otherwise.
 *
 * Existing entries in names.json always win. Anything you wrote by hand is
 * left alone; this only fills gaps.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  arg, businessNames, flag, isShortcode, normalizeHandle, openDb, pad, padL,
  resolveDbPath, resolveNamesPath,
} from "./lib.mjs";

const argv = process.argv.slice(2);
const write = flag(argv, "write");
// Must go through resolveNamesPath — a bare path.resolve("names.json") is
// relative to cwd, and the app runs this with cwd set to the code clone. That
// wrote names.json *inside* the clone while the server read it from the data
// directory, so every import silently landed somewhere nothing would ever
// read, and the UI kept reporting 0 names known.
const namesFile = resolveNamesPath(argv);
const onlyChat = Number(arg(argv, "chat") ?? 0);
const allChats = flag(argv, "all-chats") || !onlyChat;

/* ---------------- contacts ---------------- */

function addressBookPaths() {
  const root = arg(argv, "contacts")
    ? path.resolve(arg(argv, "contacts"))
    : path.join(os.homedir(), "Library/Application Support/AddressBook");
  const found = [];
  const main = path.join(root, "AddressBook-v22.abcddb");
  if (existsSync(main)) found.push(main);
  const sources = path.join(root, "Sources");
  if (existsSync(sources)) {
    for (const d of readdirSync(sources, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(sources, d.name, "AddressBook-v22.abcddb");
      if (existsSync(p)) found.push(p);
    }
  }
  return found;
}

/** contactKey -> { name, handles:Set } — one entry per person, not per handle. */
function readContacts() {
  const contacts = new Map();
  let scanned = 0;
  for (const file of addressBookPaths()) {
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch {
      continue; // an empty or locked source is not worth failing over
    }
    try {
      const rows = db
        .prepare(
          `select r.Z_PK pk, r.ZFIRSTNAME first, r.ZLASTNAME last,
                  r.ZNICKNAME nick, r.ZORGANIZATION org, p.ZFULLNUMBER handle
             from ZABCDPHONENUMBER p join ZABCDRECORD r on r.Z_PK = p.ZOWNER
            union all
           select r.Z_PK, r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME,
                  r.ZORGANIZATION, e.ZADDRESS
             from ZABCDEMAILADDRESS e join ZABCDRECORD r on r.Z_PK = e.ZOWNER`
        )
        .all();
      for (const r of rows) {
        const key = normalizeHandle(r.handle ?? "");
        if (!key) continue;
        // Same person can appear in several sources; key on their name so
        // iCloud and local copies of one contact merge rather than compete.
        const display =
          [r.first, r.last].filter(Boolean).join(" ").trim() ||
          r.nick?.trim() || r.org?.trim() || "";
        if (!display) continue;
        const id = `${display.toLowerCase()}#${r.pk}`;
        const byName = [...contacts.values()].find((c) => c.name === display);
        const entry = byName ?? contacts.get(id) ?? { name: display, handles: new Set() };
        entry.handles.add(key);
        contacts.set(byName ? byName.id ?? id : id, { ...entry, id: byName?.id ?? id });
        scanned += 1;
      }
    } finally {
      db.close();
    }
  }
  return { contacts, scanned };
}

/* ---------------- who is actually in the chats ---------------- */

const chatDb = openDb(resolveDbPath(argv));
const usage = new Map(); // normalized handle -> message count (metadata only)
let automated = 0;         // shortcodes seen and skipped
{
  const sql = allChats
    ? `select h.id id, count(*) n
         from message m join handle h on h.ROWID = m.handle_id
        where m.associated_message_type = 0 and m.item_type = 0
        group by h.id`
    : `select h.id id, count(*) n
         from message m
         join chat_message_join j on j.message_id = m.ROWID
         join handle h on h.ROWID = m.handle_id
        where j.chat_id = ? and m.associated_message_type = 0 and m.item_type = 0
        group by h.id`;
  const stmt = chatDb.prepare(sql);
  for (const r of allChats ? stmt.all() : stmt.all(onlyChat)) {
    // Shortcodes are 2FA codes and delivery alerts. They have no Contacts
    // record and never will, so listing them as "still unnamed" is a to-do
    // list of things nobody should do.
    if (isShortcode(r.id)) { automated += 1; continue; }
    const key = normalizeHandle(r.id);
    if (key) usage.set(key, (usage.get(key) ?? 0) + r.n);
  }
}
// Businesses name themselves through their chat row; nothing to ask about.
const business = businessNames(chatDb);
chatDb.close();

/* ---------------- merge ---------------- */

const existing = existsSync(namesFile)
  ? JSON.parse(readFileSync(namesFile, "utf8"))
  : {};
const existingNames = existing.names && typeof existing.names === "object"
  ? { ...existing.names }
  : Object.fromEntries(
      Object.entries(existing).filter(([k]) => k !== "names" && k !== "aliases")
    );
const existingAliases = { ...(existing.aliases ?? {}) };

// What's already spoken for, by normalized key, so nothing hand-written is
// overwritten and no alias is proposed for a handle you already placed.
const claimed = new Set(
  [...Object.keys(existingNames), ...Object.keys(existingAliases)].map(normalizeHandle)
);

const { contacts, scanned } = readContacts();

const addedNames = {};
const addedAliases = {};
const merged = [];

for (const c of contacts.values()) {
  // Only the handles this person actually messages you from.
  const active = [...c.handles].filter((h) => usage.has(h));
  if (!active.length) continue;

  // Canonical = a phone if there is one (that's the durable identity), and
  // among those the one they actually use most.
  active.sort((a, b) => {
    const aPhone = !a.includes("@"), bPhone = !b.includes("@");
    if (aPhone !== bPhone) return aPhone ? -1 : 1;
    return (usage.get(b) ?? 0) - (usage.get(a) ?? 0);
  });
  const [canonical, ...rest] = active;

  if (!claimed.has(canonical)) addedNames[canonical] = c.name;
  for (const other of rest) {
    if (!claimed.has(other)) addedAliases[other] = canonical;
  }
  if (rest.length) {
    merged.push({
      name: c.name,
      canonical,
      others: rest,
      // Already handled if every extra handle is spoken for in names.json.
      // Without this the preflight re-reports settled merges as findings and
      // a session goes looking for a problem that was fixed weeks ago.
      isNew: rest.some((h) => !claimed.has(h)),
      total: active.reduce((s, h) => s + (usage.get(h) ?? 0), 0),
    });
  }
}

/* ---------------- report ---------------- */

const scope = allChats ? "all conversations" : `chat ${onlyChat}`;
console.log(
  `\n${write ? "WRITING" : "DRY RUN — nothing written"}   ${namesFile.replace(os.homedir(), "~")}`
);
console.log(
  `contacts scanned ${scanned.toLocaleString()} handle(s) · ` +
    `${usage.size.toLocaleString()} handle(s) appear in ${scope}\n`
);

const newNameKeys = Object.keys(addedNames);
if (newNameKeys.length) {
  console.log(`New names (${newNameKeys.length}):`);
  for (const k of newNameKeys.sort((a, b) => (usage.get(b) ?? 0) - (usage.get(a) ?? 0))) {
    console.log(`  ${padL((usage.get(k) ?? 0).toLocaleString(), 8)}  ${pad(k, 22)} ${addedNames[k]}`);
  }
} else {
  console.log("No new names — everyone in your chats is already in names.json.");
}

const newMerges = merged.filter((m) => m.isNew);
const oldMerges = merged.filter((m) => !m.isNew);
if (newMerges.length) {
  console.log(`\nSplit identities NOT YET MERGED (${newMerges.length}) — one person, several handles:`);
  for (const m of newMerges.sort((a, b) => b.total - a.total)) {
    console.log(`  ${pad(m.name, 20)} ${m.canonical}  <-  ${m.others.join(", ")}`);
  }
  console.log(
    `  Until these are merged each of these people is counted as two, with\n` +
      `  their history and every stat about them split between the halves.`
  );
}
if (oldMerges.length) {
  console.log(
    `\nAlready merged (${oldMerges.length}): ` +
      `${oldMerges.map((m) => m.name).sort().join(", ")}`
  );
}

const stillUnnamed = [...usage.entries()]
  .filter(([h]) => !claimed.has(h) && !addedNames[h] && !addedAliases[h] && !business.has(h))
  .sort((a, b) => b[1] - a[1]);
if (business.size) {
  console.log(`\nNamed from their own chat rows (${business.size}) — Apple Messages for Business: ` +
    `${[...business.values()].sort().join(", ")}`);
}
if (automated) console.log(`${automated} shortcode(s) ignored — 2FA codes and alerts, not people.`);
if (stillUnnamed.length) {
  console.log(`\nStill unnamed — not in Contacts (${stillUnnamed.length}), busiest first:`);
  for (const [h, n] of stillUnnamed.slice(0, 12)) {
    console.log(`  ${padL(n.toLocaleString(), 8)}  ${h}`);
  }
  if (stillUnnamed.length > 12) console.log(`  … and ${stillUnnamed.length - 12} more`);
  console.log(`  Add these by hand in names.json if any of them matter.`);
}

if (write) {
  const out = {
    names: { ...existingNames, ...addedNames },
    aliases: { ...existingAliases, ...addedAliases },
  };
  writeFileSync(namesFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `\nWrote ${Object.keys(out.names).length} name(s) and ` +
      `${Object.keys(out.aliases).length} alias(es). Existing entries were kept as-is.\n`
  );
} else {
  console.log(`\nRe-run with --write to merge this into names.json.\n`);
}
