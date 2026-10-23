import { test } from "node:test";
import assert from "node:assert/strict";
import { loadIdentities } from "../lib.mjs";
import { personThreads } from "../person.mjs";
import { makeDb, sample } from "./fixture.mjs";

const { db, namesPath } = makeDb(sample());
const { names, canonical } = loadIdentities(namesPath, db);
const ANN = "15550000001";

test("folds strict siblings, applies the floor", () => {
  const r = personThreads(db, { handle: ANN, canonical, names, floor: 5 });
  assert.deepEqual(r.threads.map((t) => [t.id, t.ids, t.n, t.isGroup, t.name]),
    [[1, [1, 3], 5, false, "Ann"], [2, [2], 5, true, "Crew"]]);   // Ann sent 5 in Crew: m9, m11, m12, m13, m16
  assert.equal(r.others, 1);   // the other Crew, one message
});

test("floor 1 lists everything, 1:1 first", () => {
  const r = personThreads(db, { handle: ANN, canonical, names, floor: 1 });
  assert.deepEqual(r.threads.map((t) => t.id), [1, 2, 4]);
});

test("remembered merges fold same-name threads", () => {
  const r = personThreads(db, { handle: ANN, canonical, names, floor: 5, merges: { "2": { merge: true, ids: [4] } } });
  assert.deepEqual(r.threads.map((t) => [t.ids, t.n]), [[[1, 3], 5], [[2, 4], 6]]);
  assert.equal(r.others, 0);
});

test("dismissed ids are never pulled in", () => {
  const r = personThreads(db, { handle: ANN, canonical, names, floor: 1, merges: { "2": { merge: true, ids: [], dismissed: [4] } } });
  assert.deepEqual(r.threads.map((t) => t.ids), [[1, 3], [2], [4]]);
});

test("combine off keeps siblings apart", () => {
  const r = personThreads(db, { handle: ANN, canonical, names, floor: 1, combine: false });
  assert.deepEqual(r.threads.map((t) => t.ids), [[1], [3], [2], [4]]);
});

test("a handle nobody sent from has no threads", () => {
  const r = personThreads(db, { handle: "19999999999", canonical, names, floor: 1 });
  assert.deepEqual(r.threads, []); assert.equal(r.others, 0); assert.equal(r.name, null);
});
