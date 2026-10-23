import { test } from "node:test";
import assert from "node:assert/strict";
import { loadIdentities } from "../lib.mjs";
import { loadMessages, personStats } from "../analyze.mjs";
import { makeDb, sample } from "./fixture.mjs";

const { db, namesPath } = makeDb(sample());
const { names, canonical } = loadIdentities(namesPath, db);
const { msgs } = loadMessages(db, [1], { names, canonical, meName: "Me" });

test("personStats on the 1:1", () => {
  const { rows } = personStats(msgs, { gap: 6 * 3600_000 });
  const ann = rows.get("Ann"), me = rows.get("Me");
  assert.equal(ann.n, 4);
  assert.deepEqual(ann.byYear, { 2023: 3, 2024: 1 });
  assert.equal(ann.peakHour, 10);
  assert.equal(ann.doubles, 2);           // m4 after m3, m5 after m4 — the gap does not matter for doubles
  assert.equal(ann.medianReply, 60_000);  // m3 answers m2
  assert.equal(ann.starts, 2);            // m1, m5
  assert.equal(ann.lastWord, 1);          // m4
  assert.equal(ann.questions, 1);
  assert.equal(ann.laughs, 0);
  assert.equal(me.laughs, 2);             // "yes lol", "haha"
  assert.equal(ann.maxLen, [...msgs[4].text].length);
});

test("signature words respect minUses", () => {
  const { rows } = personStats(msgs, { minUses: 1 });
  assert.ok(rows.get("Ann").signature.some((w) => w.word === "coming"));
});
