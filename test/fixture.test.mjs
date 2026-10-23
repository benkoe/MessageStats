import { test } from "node:test";
import assert from "node:assert/strict";
import { loadIdentities } from "../lib.mjs";
import { analyze, loadMessages, resolveChats } from "../analyze.mjs";
import { makeDb, sample } from "./fixture.mjs";

test("fixture loads through lib and analyze", () => {
  const { db, namesPath } = makeDb(sample());
  const { names, canonical } = loadIdentities(namesPath, db);
  const { msgs, byGuid, label } = loadMessages(db, [1], { names, canonical, meName: "Me" });
  assert.deepEqual(msgs.map((m) => m.who), ["Ann", "Me", "Ann", "Ann", "Ann", "Me"]);
  const resolved = resolveChats(db, { chatId: 1, merge: true, canonical });
  assert.deepEqual(resolved.ids, [1, 3]);
  const A = analyze(db, { ids: [1], msgs, byGuid, label, chat: resolved.chat, names, canonical });
  assert.equal(A.total, 6);
});
