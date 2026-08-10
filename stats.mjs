/**
 * Conversation stats for one iMessage chat. Read-only; writes nothing.
 *
 *   node stats.mjs --chat 1259
 *   node stats.mjs --chat 1259 --merge
 *   node stats.mjs --chat 1259 --names names.json
 *   node stats.mjs --chat 1259 --top 15 --db /path/to/chat.db
 *
 * Find the ROWID with:  node list-chats.mjs
 *
 * One conversation often occupies several chat rows (a recreated group, an
 * SMS/iMessage split, a rename). This warns when that is the case and tells
 * you what share you are dropping; --merge folds them together.
 *
 * All the arithmetic lives in analyze.mjs. This file only formats it, so that
 * the terminal and the web UI can never disagree about a number.
 */

import {
  appleMicrosToMs, arg, bar, chatRosters, chatSummaries, day, flag, head, human,
  loadIdentities, openDb, pad, padL, pct, quote, resolveDbPath, resolveNamesPath,
  TZ
} from "./lib.mjs";
import { analyze, loadMessages, resolveChats, resolveMe } from "./analyze.mjs";

const argv = process.argv.slice(2);
const chatId = Number(arg(argv, "chat"));
if (!Number.isInteger(chatId) || chatId <= 0) {
  console.error("\n--chat <ROWID> is required.  Run:  node list-chats.mjs\n");
  process.exit(1);
}
const TOP = Number(arg(argv, "top") ?? 10);
// --merge          fold in sibling threads holding exactly the same people
// --merge 2488,3676  ALSO fold in these chat ids, whatever their rosters. The
//                    siblings come too — explicit ids used to replace them,
//                    which quietly made a merged report smaller than the
//                    unmerged one it was meant to complete.
const MERGE = flag(argv, "merge");
const mergeArg = arg(argv, "merge");
const MERGE_IDS = (mergeArg && !mergeArg.startsWith("--") ? mergeArg : "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

let db;
try {
  db = openDb(resolveDbPath(argv));
} catch (err) {
  // The message here is the setup instructions — a stack trace on top of them
  // just buries the thing the reader needs.
  console.error(`\n${err.message}\n`);
  process.exit(1);
}
const { names, canonical } = loadIdentities(resolveNamesPath(argv));

const resolved = resolveChats(db, { chatId, merge: MERGE, mergeIds: MERGE_IDS, canonical });
if (!resolved) {
  console.error(`\nNo chat with ROWID ${chatId}. Run: node list-chats.mjs\n`);
  process.exit(1);
}
const { chat, ids, siblings, named, ignored } = resolved;
if (ignored.length) console.error(`\nIgnoring --merge id(s) with no messages: ${ignored.join(", ")}\n`);

const meName = resolveMe(db, ids, { names, canonical });
const { msgs, byGuid, label } = loadMessages(db, ids, { names, canonical, meName });
if (msgs.length < 2) {
  console.log(`\nOnly ${msgs.length} readable message(s) in chat ${chatId}. Nothing to say.\n`);
  process.exit(0);
}

const A = analyze(db, { ids, msgs, byGuid, label, chat, top: TOP, names, canonical });
const P = A.perPerson;

/* ---------------- header ---------------- */

console.log(`\n\x1b[1m${A.chat.name}\x1b[0m — ${A.total.toLocaleString()} messages, ${A.people.length} people`);
console.log(
  `${day(A.first)} .. ${day(A.last)}  (${A.spanDays.toLocaleString()} days, ` +
    `${A.perDay.toFixed(1)}/day average)`
);
// iMessage stores an instant and no timezone, so every date and clock time here
// is this machine's — not the sender's, who may have been somewhere else.
console.log(`\x1b[2mDates and times in ${TZ}.\x1b[0m`);

const listOf = (xs) => xs.map((s) => `${s.id} (${s.n.toLocaleString()})`).join(", ");

if (ids.length > 1) {
  const extra = ids.slice(1).map((id) => siblings.concat(named).find((s) => s.id === id) ?? { id, n: 0 });
  console.log(`\x1b[36mMerged ${ids.length} threads: ${chatId} + ${listOf(extra)}\x1b[0m`);
  // A renamed thread is still the same conversation, and the other names are
  // how you recognise it. Keep every one of them on screen.
  const holes = ids.map(() => "?").join(",");
  const alt = [...new Set(
    db.prepare(`select display_name dn from chat where ROWID in (${holes})`)
      .all(...ids).map((r) => r.dn?.trim()).filter(Boolean)
  )].filter((n) => n !== A.chat.name);
  if (alt.length) console.log(`\x1b[36m  also known as: ${alt.map((n) => `"${n}"`).join(", ")}\x1b[0m`);

  // When the merged rosters differ, membership is part of the story — a work
  // group with staff churn reads as nonsense without it.
  const rosters = chatRosters(db, canonical);
  const keyOf = (id) => [...(rosters.get(id) ?? [])].sort().join("|");
  if (new Set(ids.map(keyOf)).size > 1) {
    console.log(`\x1b[36m  rosters differ across these threads:\x1b[0m`);
    // Spans for every id including the one that was asked for: it is in neither
    // `siblings` nor `named`, and falling back to the whole merge's span
    // printed the biggest thread as if it covered all of it.
    const spans = chatSummaries(db, ids);
    for (const id of ids) {
      const s = spans.get(id);
      const who = [...(rosters.get(id) ?? [])].map((h) => names.get(h) ?? h).sort().join(", ");
      const span = s?.first_us
        ? `${day(appleMicrosToMs(s.first_us))} → ${day(appleMicrosToMs(s.last_us))}`
        : "—";
      console.log(`    ${String(id).padEnd(6)}${(s?.n ?? 0).toLocaleString().padStart(7)}  ${span}   ${who || "—"}`);
    }
    console.log(
      `\x1b[36m  Per-person totals below span the whole merge, so someone present\x1b[0m` +
        `\n\x1b[36m  for only part of it will look quiet. Read the per-year columns.\x1b[0m`
    );
  }
} else if (siblings.length) {
  const extra = siblings.reduce((s, x) => s + x.n, 0);
  const share = (extra / (A.total + extra)) * 100;
  console.log(
    `\n\x1b[33m⚠  These same ${A.people.length} people also have ` +
      `${extra.toLocaleString()} message(s) in ${siblings.length} other thread(s): ${listOf(siblings)}\x1b[0m` +
      `\n\x1b[33m   Roughly ${share < 0.05 ? "<0.1" : share.toFixed(1)}% of this conversation ` +
      `is missing from everything below.\x1b[0m` +
      `\n   Re-run with --merge to include it:  node stats.mjs --chat ${chatId} --merge`
  );
}

// Softer tier: same name, different roster. Only the threads still outside the
// merge — offering to fold in one that is already folded in is how the web UI's
// version of this warning came to look like a button that did nothing.
const pendingNamed = named.filter((s) => !ids.includes(s.id));
if (pendingNamed.length) {
  const extra = pendingNamed.reduce((s, x) => s + x.n, 0);
  console.log(
    `\n\x1b[33m?  ${pendingNamed.length} other thread(s) share this name but have a different ` +
      `roster: ${listOf(pendingNamed)}\x1b[0m` +
      `\n   ${extra.toLocaleString()} messages. Could be one group with people joining and` +
      `\n   leaving — or a deliberately separate chat. NOT merged automatically.` +
      `\n   If it is the same group:  node stats.mjs --chat ${chatId} --merge ${[chatId, ...pendingNamed.map((s) => s.id)].join(",")}`
  );
}

/* ---------------- per person ---------------- */

const maxPer = P[0].n;
head("Messages per person");
console.log(`${pad("", 14)}${padL("TOTAL", 8)}  ${A.years.map((y) => padL(y, 7)).join("")}`);
for (const p of P) {
  const cells = A.years.map((y) => padL(p.byYear[y] ?? 0, 7)).join("");
  console.log(`${pad(p.who, 14)}${padL(p.n.toLocaleString(), 8)}  ${cells}  ${padL(pct(p.n, A.total), 6)} ${bar(p.n, maxPer, 12)}`);
}

/* ---------------- busiest ---------------- */

const B = A.busiest;
head("Busiest stretches");
console.log(`  busiest day    ${B.day.key}          ${B.day.n.toLocaleString()}`);
console.log(`  busiest week   week of ${B.week.key}  ${B.week.n.toLocaleString()}`);
console.log(`  busiest month  ${B.month.key}             ${B.month.n.toLocaleString()}`);
console.log(`  busiest hour   ${B.hour.key}       ${B.hour.n.toLocaleString()}`);
console.log(`\n  longest streak   ${B.streak.days} consecutive days (${B.streak.start} .. ${B.streak.end})`);
console.log(`  days with any    ${B.activeDays.toLocaleString()} of ${A.spanDays.toLocaleString()} (${pct(B.activeDays, A.spanDays)})`);
if (B.silence) {
  console.log(`  longest silence  ${human(B.silence.ms)} after ${B.silence.after.who} on ${day(B.silence.after.ms)}`);
  console.log(`                   "${quote(B.silence.after.text, 90)}"`);
}

/* ---------------- rhythm ---------------- */

head("When they talk");
console.log(`  clock times in ${TZ} — messages sent while travelling read as this timezone\n`);
const maxHour = Math.max(...A.rhythm.hours);
for (let h = 0; h < 24; h += 1) {
  console.log(`  ${String(h).padStart(2, "0")}:00 ${padL(A.rhythm.hours[h].toLocaleString(), 8)} ${bar(A.rhythm.hours[h], maxHour, 42)}`);
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const maxDow = Math.max(...A.rhythm.dow);
console.log();
for (let d = 0; d < 7; d += 1) {
  console.log(`  ${DOW[d]}  ${padL(A.rhythm.dow[d].toLocaleString(), 8)} ${bar(A.rhythm.dow[d], maxDow, 42)}`);
}
console.log(`\n  peak hour, and who's up at 2am:`);
for (const p of P) {
  console.log(
    `    ${pad(p.who, 14)} peak ${String(p.peakHour).padStart(2, "0")}:00   ` +
      `midnight-5am ${padL(p.night.toLocaleString(), 7)} (${pct(p.night, p.n)})`
  );
}

/* ---------------- length ---------------- */

head("Message length");
for (const p of P) {
  console.log(
    `  ${pad(p.who, 14)} avg ${padL(p.avgLen.toFixed(1), 6)}   median ${padL(p.medianLen, 5)}   longest ${padL(p.maxLen.toLocaleString(), 7)}`
  );
}
console.log(`\n  longest ever: ${A.longest.len.toLocaleString()} chars by ${A.longest.who}, ${day(A.longest.ms)}`);
console.log(`    "${quote(A.longest.text, 160)}"`);

/* ---------------- dynamics ---------------- */

const D = A.dynamics;
head("Conversation dynamics");
console.log(`  ${pad("", 14)}${padL("STARTS", 8)}${padL("LAST WORD", 11)}${padL("MEDIAN REPLY", 14)}${padL("DOUBLE-TEXTS", 14)}`);
for (const p of P) {
  console.log(
    `  ${pad(p.who, 14)}${padL(p.starts, 8)}${padL(p.lastWord, 11)}` +
      `${padL(human(p.medianReply), 14)}` +
      `${padL(`${p.doubles.toLocaleString()} (${pct(p.doubles, p.n)})`, 14)}`
  );
}
console.log(`\n  "starts" = first message after ${D.gapHours}h of silence · "last word" = spoke before one`);
console.log(`  longest monologue: ${D.monologue.n} messages in a row by ${D.monologue.who}, ${day(D.monologue.at)}`);
if (D.fastest) {
  console.log(`  fastest reply: ${(D.fastest.ms / 1000).toFixed(1)}s — ${D.fastest.reply.who} to ${D.fastest.to.who}, ${day(D.fastest.reply.ms)}`);
  console.log(`    ${D.fastest.to.who}: "${quote(D.fastest.to.text, 60)}"`);
  console.log(`    ${D.fastest.reply.who}: "${quote(D.fastest.reply.text, 60)}"`);
}

if (A.people.length > 2) {
  head("How fast people answer (inferred)");
  console.log(`  Assumes whoever spoke next was answering, so it covers everything and`);
  console.log(`  is a guess. "Who replies to whom" below is exact but sparser.\n`);
  console.log(`  ${pad("replier \\ to", 14)}${A.people.map((p) => padL(pad(p, 8), 9)).join("")}`);
  for (const row of D.matrix) {
    const cells = A.people.map((b) => padL(row.who === b ? "·" : row.to[b] == null ? "—" : human(row.to[b]), 9));
    console.log(`  ${pad(row.who, 14)}${cells.join("")}`);
  }
  console.log(`  (blank = fewer than 5 replies to go on)`);
}

/* ---------------- what the links were ---------------- */

if (A.richLinks) {
  const L = A.richLinks;
  head("What the links were");
  console.log(`  ${L.titled.toLocaleString()} of ${L.cards.toLocaleString()} previews kept their title and site.`);
  console.log(`  Read from the database — nothing is fetched, so no one learns what you shared.\n`);
  if (L.topSites.length) {
    console.log(`  ${L.topSites.map((s) => `${s.site} ${s.n.toLocaleString()}`).join(" · ")}\n`);
  }
  for (const x of L.recent.slice(0, 8)) {
    console.log(`  ${day(x.ms)}  ${pad(x.who, 14)} ${quote(x.title, 60)}${x.site ? `  (${x.site})` : ""}`);
  }
  if (L.reposts.length) {
    console.log(`\n  sent more than once:`);
    for (const x of L.reposts.slice(0, 5)) {
      console.log(`    ${x.n}x  ${quote(x.title, 52)} — ${x.who.join(", ")}`);
    }
  }
}

/* ---------------- how it's sent ---------------- */

if (A.services) {
  const S = A.services;
  head("How it's sent");
  console.log(`  ${S.totals.map((t) => `${t.name} ${t.n.toLocaleString()} (${day(t.first)} → ${day(t.last)})`).join("\n  ")}`);
  const cols = S.totals.map((t) => t.name);
  console.log(`\n  ${pad("", 18)}${cols.map((c) => padL(c, 10)).join("")}`);
  for (const p of S.people) {
    // Counts, not shares: 0.2% rounds to "0%" and reads as never.
    console.log(`  ${pad(p.who, 18)}${cols.map((c) => padL(p.mix[c] ? p.mix[c].toLocaleString() : "—", 10)).join("")}`);
  }
}

/* ---------------- who answers whom ---------------- */

if (A.replyGraph?.edges.length) {
  const G = A.replyGraph;
  head("Who replies to whom (exact)");
  console.log(`  from ${G.used.toLocaleString()} messages sent with the reply gesture — ${(G.share * 100).toFixed(1)}% of this conversation.`);
  console.log(`  Exact, unlike the reply times above, which assume whoever spoke next was answering.\n`);
  for (const e of G.edges.slice(0, 12)) {
    console.log(`  ${pad(e.from, 16)} → ${pad(e.to, 16)} ${padL(e.n.toLocaleString(), 6)}` +
      (e.medianMs != null ? `   median ${human(e.medianMs)}` : ""));
  }
  console.log(`\n  ${pad("", 16)}${padL("GAVE", 8)}${padL("GOT", 8)}`);
  for (const p of A.replyGraph.perPerson) {
    if (!p.given && !p.got) continue;
    console.log(`  ${pad(p.who, 16)}${padL(p.given.toLocaleString(), 8)}${padL(p.got.toLocaleString(), 8)}`);
  }
  console.log(`  "got" = replies their own messages drew.`);
}

/* ---------------- group history ---------------- */

if (A.groupHistory) {
  head("Group history");
  for (const e of A.groupHistory.events) {
    const what =
      e.kind === "renamed" ? `renamed to "${e.title ?? "(no name)"}"`
      : e.kind === "left"  ? `${e.actor === "Unknown" ? "someone" : e.actor} left`
      : e.kind === "added" ? `${e.target} joined`
                           : `${e.target} was removed`;
    const by = e.kind !== "left" && e.actor && e.actor !== "Unknown" ? `  — by ${e.actor}` : "";
    console.log(`  ${day(e.ms)}  ${what}${by}`);
  }
  if (A.groupHistory.events.length) {
    console.log(`  (an add and a remove of one person on the same day is usually a handle switch)`);
  }
  if (A.groupHistory.departed.length) {
    console.log(`\n  ${A.groupHistory.departed.join(", ")} — messages here but on no membership list.`);
    console.log(`  They left; chat_handle_join forgot them while the messages stayed.`);
  }
}

/* ---------------- tapbacks ---------------- */

if (A.tapbacks) {
  head("Tapbacks");
  // A column per reaction, headed by its glyph — same shape as the web UI, so
  // neither can show a breakdown the other doesn't know about.
  const K = A.tapbacks.kinds;
  console.log(`  ${A.tapbacks.total.toLocaleString()} total`);
  console.log(`\n  ${pad("", 14)}${K.map((k) => padL(k.icon, 8)).join("")}` +
    `${padL("GIVEN", 8)}${padL("GOT", 8)}${padL("RATIO", 8)}${padL("PER MSG", 9)}`);
  for (const p of P) {
    const mix = p.gaveKinds ?? {};
    console.log(
      `  ${pad(p.who, 14)}${K.map((k) => padL((mix[k.kind] ?? 0).toLocaleString(), 8)).join("")}` +
        `${padL(p.given.toLocaleString(), 8)}${padL(p.received.toLocaleString(), 8)}` +
        `${padL(p.received ? (p.given / p.received).toFixed(2) : "—", 8)}${padL((p.received / p.n).toFixed(3), 9)}`
    );
  }
  console.log(`  ${pad("everyone", 14)}${K.map((k) => padL(k.n.toLocaleString(), 8)).join("")}`);
  console.log(`  ${K.map((k) => `${k.icon} ${k.kind}`).join(" · ")}`);
  // "emoji 93" says nothing; which emoji says a lot.
  if (A.tapbacks.customEmoji?.length) {
    console.log(`  picked by hand: ${A.tapbacks.customEmoji.map((e) => `${e.emoji} ${e.n}`).join(" · ")}`);
  }
  console.log(`  ratio = given/got. Under 1.00 means they receive more than they give.`);
  // Counted as distinct people, so two-person chats can only score 2, 1 or
  // nothing — no ranking worth printing. See the same rule in the web UI.
  if (A.people.length > 2 && A.tapbacks.mostReacted.length) {
    console.log(`\n  most-reacted messages (people who reacted, not taps):`);
    for (const { n, msg } of A.tapbacks.mostReacted) {
      const body = (msg.text || "").replace(/￼/g, "").trim();
      console.log(`    ${padL(n, 3)}  ${pad(msg.who, 12)} ${day(msg.ms)}  ` +
        (body ? `"${quote(body, 78)}"` : "(no text — an attachment)"));
    }
  }
}

/* ---------------- words ---------------- */

head(`Most-used words (top ${TOP})`);
for (const p of P) {
  if (!p.topWords.length) continue;
  console.log(`  \x1b[1m${p.who}\x1b[0m`);
  console.log(`    ${p.topWords.map((w) => `${w.word} (${w.n.toLocaleString()})`).join(", ")}`);
}

head("Signature words — said far more than everyone else does");
for (const s of A.signature.people) {
  console.log(`  \x1b[1m${s.who}\x1b[0m`);
  console.log(
    `    ${s.words.map((w) => (w.ratio == null ? `${w.word} (${w.n}×, only them)` : `${w.word} (${w.n}×, ${w.ratio.toFixed(1)}x)`)).join(", ")}`
  );
}
console.log(`  (Nx = how many times more often than the rest of the group; min ${A.signature.minUses} uses)`);

if (A.pickedUp) {
  head("Words they picked up — not there at the start, a habit by the end");
  for (const s of A.pickedUp.people) {
    console.log(`  \x1b[1m${s.who}\x1b[0m`);
    console.log(`    ${s.words.map((w) => `${w.word} (${w.n}×, from ${day(w.at)})`).join(", ")}`);
  }
  console.log(`  (first used at least a fifth of the way in, then used ${A.pickedUp.minUses}+ times)`);
}

if (A.emoji.overall.length) {
  head("Emoji");
  console.log(`  overall  ${A.emoji.overall.map((e) => `${e.emoji} ${e.n}`).join("   ")}`);
  for (const p of P) {
    if (p.topEmoji.length) console.log(`  ${pad(p.who, 14)} ${p.topEmoji.map((e) => `${e.emoji} ${e.n}`).join("  ")}`);
  }
}

/* ---------------- attachments ---------------- */

const size = (b) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round(b / 1e3)} KB`;

if (A.attachments) {
  head("Attachments");
  if (A.attachments.total) {
    console.log(`  ${pad("", 14)}${padL("FILES", 8)}${padL("SIZE", 10)}   WHAT`);
    for (const p of P) {
      if (!p.attachments) continue;
      console.log(
        `  ${pad(p.who, 14)}${padL(p.attachments.toLocaleString(), 8)}${padL(size(p.attachmentBytes), 10)}   ` +
          p.attachmentKinds.map((k) => `${k.kind} ${k.n}`).join(", ")
      );
    }
    // Camera roll vs screen capture — same mime type, different filenames.
    const shooters = P.filter((p) => p.screenshots || p.cameraPhotos || p.screenRecordings);
    if (shooters.some((p) => p.screenshots || p.screenRecordings)) {
      console.log(`\n  ${pad("", 18)}${padL("CAMERA", 9)}${padL("SHOTS", 9)}${padL("RECORD", 9)}${padL("SCREEN", 9)}`);
      for (const p of shooters) {
        const shot = p.screenshots + p.screenRecordings, tot = shot + p.cameraPhotos;
        console.log(`  ${pad(p.who, 18)}${padL(p.cameraPhotos.toLocaleString(), 9)}` +
          `${padL(p.screenshots || "—", 9)}${padL(p.screenRecordings || "—", 9)}` +
          `${padL(tot ? `${Math.round((shot / tot) * 100)}%` : "—", 9)}`);
      }
      console.log(`  from the filename: IMG_… is the camera, Screenshot… the screen, RPReplay… a recording`);
    }
    console.log(`\n  ${A.attachments.total.toLocaleString()} files, ${size(A.attachments.bytes)} in total`);
    const years = Object.entries(A.attachments.byYear);
    if (years.length > 1) {
      const max = Math.max(...years.map(([, n]) => n));
      console.log();
      for (const [y, n] of years) console.log(`    ${y}  ${padL(n.toLocaleString(), 6)}  ${bar(n, max, 20)}`);
    }
  }
  // Kept out of every number above: see attachmentKind() in analyze.mjs.
  if (A.attachments.linkCards) {
    console.log(
      `\n  Plus ${A.attachments.linkCards.toLocaleString()} link preview cards, which iMessage generates` +
        `\n  automatically for URLs. Not counted above — they aren't something anyone sent.`
    );
  }
}

if (A.edits) {
  head("Second thoughts");
  console.log(`  ${pad("", 14)}${padL("UNSENT", 9)}${padL("EDITED", 9)}`);
  for (const p of P) {
    if (!p.unsent && !p.edited) continue;
    console.log(`  ${pad(p.who, 14)}${padL(p.unsent.toLocaleString(), 9)}${padL(p.edited.toLocaleString(), 9)}`);
  }
  if (!A.edits.unsent) console.log(`  No unsent messages recorded — macOS only keeps them from Ventura on.`);
}

if (A.read) {
  head("Read receipts");
  const line = (side, what) => {
    if (!side) return `  ${pad(what, 22)}—`;
    return `  ${pad(what, 22)}${side.medianMs == null
      ? `${side.n} sample${side.n === 1 ? "" : "s"} — too few to draw a median from`
      : `${human(side.medianMs)} median  (${side.n.toLocaleString()} messages)`}`;
  };
  console.log(line(A.read.byThem, "they read yours in"));
  console.log(line(A.read.byMe, "you read theirs in"));
  console.log(
    `\n  Only counts messages where the reader had read receipts on, which is` +
      `\n  ${(A.read.coverage * 100).toFixed(0)}% of this conversation. A low count on one side usually just` +
      `\n  means that person keeps them switched off.`
  );
}

/* ---------------- odds and ends ---------------- */

head("Odds and ends");
console.log(`  ${pad("", 14)}${padL("LAUGHS", 9)}${padL("ASKS ?", 9)}${padL("SHOUTS", 9)}${padL("LINKS", 8)}${padL("VOCAB", 8)}`);
for (const p of P) {
  console.log(
    `  ${pad(p.who, 14)}${padL(pct(p.laughs, p.n), 9)}${padL(pct(p.questions, p.n), 9)}` +
      `${padL(p.shouts.toLocaleString(), 9)}${padL(p.links.toLocaleString(), 8)}${padL(p.vocab.toLocaleString(), 8)}`
  );
}
console.log(`  laughs/asks = % of their messages · shouts = ALL-CAPS words · vocab = distinct words`);

if (A.odds.domains.length) {
  console.log(`\n  most-shared domains:`);
  for (const d of A.odds.domains) console.log(`    ${padL(d.n.toLocaleString(), 6)}  ${d.domain}`);
}

console.log(`\n  most-repeated messages:`);
for (const r of A.odds.repeated) console.log(`    ${padL(r.n.toLocaleString(), 6)}  "${quote(r.text, 60)}"`);

// One-liners on purpose: a handful of bubbles, and voice notes are rare.
if (A.apps) console.log(`\n  apps: ${A.apps.map((a) => `${a.name} ${a.n.toLocaleString()}`).join(" · ")}`);
if (A.audio) {
  // played is only meaningful against received: your own sends never get a
  // local played mark, so lumping them implied ignored voice notes.
  console.log(`  voice notes: ${A.audio.sent.toLocaleString()} sent, ${A.audio.received.toLocaleString()} received` +
    (A.audio.received ? ` (${A.audio.played.toLocaleString()} played)` : "") +
    (A.audio.sparse ? " — too few to read anything into" : ""));
}

console.log(`\n  first ever   ${day(A.odds.firstMsg.ms)}  ${A.odds.firstMsg.who}: "${quote(A.odds.firstMsg.text, 90)}"`);
console.log(`  latest       ${day(A.odds.lastMsg.ms)}  ${A.odds.lastMsg.who}: "${quote(A.odds.lastMsg.text, 90)}"`);

console.log();
db.close();
