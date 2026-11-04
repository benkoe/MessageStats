import { test } from "node:test";
import assert from "node:assert/strict";
import { loadIdentities } from "../lib.mjs";
import { excerpts, loadMessages, loadReactions, questionTerms } from "../analyze.mjs";
import { makeDb, sample } from "./fixture.mjs";

const { db, namesPath } = makeDb(sample());
const { names, canonical } = loadIdentities(namesPath, db);

/** The whole fixture as one corpus: each thread loaded on its own and tagged. */
const corpus = [];
let reactions = { reactors: new Map(), laughReactors: new Map() };
for (const [ids, thread, isGroup] of [[[1, 3], "Ann", false], [[2], "Crew", true], [[4], "Crew", true]]) {
  const { msgs, byGuid, label } = loadMessages(db, ids, { names, canonical, meName: "Me" });
  for (const m of msgs) corpus.push({ ...m, thread, isGroup });
  const r = loadReactions(db, ids, { byGuid, label });
  for (const [k, v] of r.reactors) reactions.reactors.set(k, v);
  for (const [k, v] of r.laughReactors) reactions.laughReactors.set(k, v);
}
corpus.sort((a, b) => a.ms - b.ms);

test("rules pick what the spec says", () => {
  const ex = excerpts(corpus, { who: "Ann", reactions, budget: 40000 });
  const by = (rule) => ex.lines.filter((l) => l.why.includes(rule)).map((l) => l.guid);
  assert.deepEqual(by("reacted"), ["m9"]);              // m11's reaction was removed, m16 is attachment-only
  assert.deepEqual(by("laughed").sort(), ["m1", "m9"]); // "yes lol" in 1 min, "lmao" in 1 min; "haha" 30 min later misses
  assert.ok(by("longest").includes("m5"));
  assert.ok(ex.lines.find((l) => l.why.includes("repeated") && l.text.startsWith("(×2) coming over")));
  assert.deepEqual(by("unanswered").sort(), ["m11", "m12", "m13"]); // each followed only by Ann herself, over an hour later
  assert.ok(ex.lines.every((l) => l.guid !== "m16"));
  assert.equal(ex.lines.find((l) => l.guid === "m9").before.who, "Bob");
  assert.ok(ex.counts.spread >= 1);
  assert.ok(ex.lines.every((l) => l.who === "Ann"));
});

test("search terms come from the question", () => {
  assert.deepEqual(questionTerms("what did Ann say about coming over?"), ["coming"]); // "what", "about", "over" are stop words; "ann" is too short
  const ex = excerpts(corpus, { who: "Ann", budget: 0, terms: ["coming"] });
  assert.deepEqual(ex.lines.map((l) => l.guid).sort(), ["m11", "m4"]);
  assert.ok(ex.lines.every((l) => l.term === "coming"));
});

test("search spans every year, not the newest hits, and a common term cannot crowd out a rare one", () => {
  const msgs = [];
  for (let y = 2020; y < 2026; y += 1) for (let k = 0; k < 200; k += 1)
    msgs.push({ guid: `${y}-${k}`, who: "Ann", ms: new Date(y, 0, 1 + k).getTime(),
      text: "going to the beach", len: 18, thread: "T", isGroup: false });
  msgs.push({ guid: "rare", who: "Ann", ms: new Date(2021, 5, 1).getTime(), text: "the wedding toast", len: 17, thread: "T", isGroup: false });
  msgs.sort((a, b) => a.ms - b.ms);
  const ex = excerpts(msgs, { budget: 0, searchCharCap: 2000, terms: ["beach", "wedding"] });
  const beach = ex.lines.filter((l) => l.term === "beach");
  assert.ok(beach.length > 40);                                                    // no 40-hit ceiling
  assert.equal(new Set(beach.map((l) => new Date(l.ms).getFullYear())).size, 6);   // every year, not just the last
  assert.ok(ex.lines.some((l) => l.guid === "rare"));
  assert.deepEqual(ex.searchMatches, { beach: 1200, wedding: 1 });
  assert.ok(ex.searchUsed <= 2000);
});

test("opinion questions search for the subject, not the asking", () => {
  assert.deepEqual(questionTerms("what does everyone think about Elie?"), ["elie"]);
  assert.deepEqual(questionTerms("what are peoples opinions on the knicks"), ["knicks"]);
  assert.deepEqual(questionTerms("how does the group feel about Shlomo moving to israel"), ["shlomo", "moving", "israel"]);
});

test("a quiet year and a quiet sender get lines before a busy one gets more", () => {
  const msgs = [];
  const push = (y, k, who) => msgs.push({ guid: `${y}-${who}-${k}`, who, ms: new Date(y, 0, 1, 0, k).getTime(),
    text: "the knicks again", len: 16, thread: "G", isGroup: true });
  for (let k = 0; k < 500; k += 1) push(2026, k, "Ann");   // a loud recent year from one person
  push(2022, 0, "Bob"); push(2022, 1, "Bob");              // a quiet old year from someone else
  push(2024, 0, "Cat");
  msgs.sort((a, b) => a.ms - b.ms);
  const ex = excerpts(msgs, { budget: 0, searchCharCap: 160, terms: ["knicks"] });   // room for 10 lines
  const got = ex.lines.map((l) => `${new Date(l.ms).getFullYear()} ${l.who}`);
  assert.equal(got.length, 10);
  assert.equal(got.filter((g) => g === "2022 Bob").length, 2);
  assert.equal(got.filter((g) => g === "2024 Cat").length, 1);
  assert.deepEqual(ex.searchCoverage.knicks, { 2022: [2, 2], 2024: [1, 1], 2026: [7, 500] });
});

test("every match is sent when it fits, with the reply that carries the opinion", () => {
  const t0 = new Date(2023, 3, 1).getTime();
  const msgs = [
    { guid: "a", who: "Ann", ms: t0, text: "elie got engaged", len: 16, thread: "G", isGroup: true },
    { guid: "b", who: "Bob", ms: t0 + 60_000, text: "finally, she is great", len: 21, thread: "G", isGroup: true },
    { guid: "c", who: "Cat", ms: t0 + 86_400_000, text: "elie is late again", len: 18, thread: "G", isGroup: true },
    { guid: "d", who: "Cat", ms: t0 + 86_460_000, text: "typical", len: 7, thread: "G", isGroup: true },
  ];
  const ex = excerpts(msgs, { budget: 0, terms: ["elie"] });
  assert.deepEqual(ex.lines.map((l) => l.guid), ["a", "c"]);
  assert.equal(ex.lines[0].after.text, "finally, she is great");   // somebody else, within the half hour
  assert.equal(ex.lines[1].after, undefined);                      // same sender is not a reply
  assert.equal(ex.searchMatches.elie, 2);
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

test("chat scope takes everyone", () => {
  const ex = excerpts(corpus.filter((m) => m.thread === "Ann"), { budget: 40000 });
  assert.ok(ex.lines.some((l) => l.who === "Me"));
});

test("a spread reaches every thread even when long messages compete for the budget", () => {
  const msgs = [];
  for (let t = 0; t < 10; t += 1) for (let k = 0; k < 5; k += 1)
    msgs.push({ guid: `t${t}m${k}`, who: "Ann", ms: Date.UTC(2023, 0, 1) + (t * 5 + k) * 60_000,
      text: "x".repeat(100), len: 100, thread: `T${t}`, isGroup: false });
  const ex = excerpts(msgs, { who: "Ann", budget: 3000 });
  assert.equal(new Set(ex.lines.map((l) => l.thread)).size, 10);   // every thread represented
  assert.ok(ex.counts.spread >= 1);                                  // the spread was not starved
  assert.ok(ex.used <= 3000);
});

test("two threads with the same name are still two threads", () => {
  const t0 = Date.UTC(2023, 0, 1);
  const msgs = [
    { guid: "a1", who: "Ann", ms: t0, text: "a joke", len: 6, thread: "Crew", threadId: 2, isGroup: true },
    { guid: "b1", who: "Bob", ms: t0 + 60_000, text: "lol", len: 3, thread: "Crew", threadId: 4, isGroup: true },
  ];
  const ex = excerpts(msgs, { who: "Ann", budget: 1000 });
  assert.equal(ex.lines.filter((l) => l.why.includes("laughed")).length, 0);   // Bob laughed in a different thread
});

test("a link-only message is never an excerpt, however popular", () => {
  const t0 = Date.UTC(2023, 0, 1);
  const url = "https://example.com/watch?v=abcdefghijklmnopqrstuvwxyz&utm_source=share";
  const msgs = [
    { guid: "u1", who: "Ann", ms: t0, text: url, len: url.length, thread: "Crew", threadId: 2, isGroup: true },
    { guid: "u2", who: "Ann", ms: t0 + 1000, text: "  " + url + " ", len: url.length + 3, thread: "Crew", threadId: 2, isGroup: true },
    { guid: "u3", who: "Ann", ms: t0 + 2000, text: "look at this " + url, len: 13 + url.length, thread: "Crew", threadId: 2, isGroup: true },
    { guid: "b1", who: "Bob", ms: t0 + 3000, text: "lol", len: 3, thread: "Crew", threadId: 2, isGroup: true },
  ];
  const reactions = { reactors: new Map([["u1", new Set(["Bob", "Me"])]]), laughReactors: new Map([["u1", new Set(["Bob"])]]) };
  const ex = excerpts(msgs, { who: "Ann", reactions, budget: 5000 });
  assert.deepEqual(ex.lines.map((l) => l.guid), ["u3"]);   // a link with words around it still counts
});
