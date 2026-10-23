import { test } from "node:test";
import assert from "node:assert/strict";
import { loadIdentities } from "../lib.mjs";
import { personCorpus, personDetail } from "../person.mjs";
import { makeDb, sample } from "./fixture.mjs";

const { db, namesPath } = makeDb(sample());
const { names, canonical } = loadIdentities(namesPath, db);
const ANN = "15550000001", BOB = "15550000002";

test("corpus spans every thread above the floor", () => {
  const c = personCorpus(db, { handle: ANN, names, canonical, merges: {}, combine: true, floor: 1 });
  assert.equal(c.name, "Ann");
  assert.deepEqual([...new Set(c.msgs.map((m) => m.thread))].sort(), ["Ann", "Crew (2023)", "Crew (2023–2024)"]);
  assert.equal(c.msgs.filter((m) => m.who === "Ann").length, 11);
  assert.equal(c.reactions.reactors.get("m9").size, 2);
  assert.ok(c.msgs.every((m, i) => i === 0 || m.ms >= c.msgs[i - 1].ms));
  assert.equal(c.msgs.find((m) => m.guid === "m9").isGroup, true);
});

test("detail has one row per thread with the person's numbers", () => {
  const c = personCorpus(db, { handle: ANN, names, canonical, merges: {}, combine: true, floor: 1 });
  const d = personDetail(c, {});
  assert.equal(d.person.total, 11);
  assert.equal(d.person.threadCount, 3);
  assert.equal(d.person.name, "Ann");
  assert.equal(d.person.handle, ANN);
  assert.deepEqual(d.person.aka, []);   // one handle, no aliases: nothing to list
  const one = d.threads.find((t) => t.id === 1);
  assert.equal(one.n, 5); assert.equal(one.total, 7);
  assert.deepEqual(one.row.byYear, { 2022: 1, 2023: 3, 2024: 1 });
  assert.ok(Math.abs(one.share - 5 / 7) < 1e-9);
  assert.ok(typeof d.person.tz === "string");
});

test("a person below the floor everywhere has no threads and does not throw", () => {
  const c = personCorpus(db, { handle: BOB, names, canonical, merges: {}, combine: true, floor: 10 });
  const d = personDetail(c, {});
  assert.deepEqual(d.threads, []); assert.equal(d.person.others, 1); assert.equal(d.person.total, 0);
});
