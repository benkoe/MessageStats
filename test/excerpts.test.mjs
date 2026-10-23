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
