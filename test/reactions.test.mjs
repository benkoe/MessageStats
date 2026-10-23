import { test } from "node:test";
import assert from "node:assert/strict";
import { loadIdentities } from "../lib.mjs";
import { loadMessages, loadReactions } from "../analyze.mjs";
import { makeDb, sample } from "./fixture.mjs";

const { db, namesPath } = makeDb(sample());
const { names, canonical } = loadIdentities(namesPath, db);
const { byGuid, label } = loadMessages(db, [2], { names, canonical, meName: "Me" });

test("reactions resolve removals and count distinct reactors", () => {
  const r = loadReactions(db, [2], { byGuid, label });
  assert.equal(r.reactors.get("m9").size, 2);          // Bob laughed, Me loved
  assert.deepEqual([...r.laughReactors.get("m9")], ["Bob"]);
  assert.equal(r.reactors.has("m11"), false);           // loved then taken back
  assert.equal(r.seen, 6);
  assert.ok(r.latest.every((t) => t.amt < 3000));
});
