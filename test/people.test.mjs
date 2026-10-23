import { test } from "node:test";
import assert from "node:assert/strict";
import { loadIdentities } from "../lib.mjs";
import { peopleDirectory } from "../person.mjs";
import { makeDb, sample } from "./fixture.mjs";

const { db, namesPath } = makeDb(sample());
const { names, canonical } = loadIdentities(namesPath, db);

test("directory lists senders by canonical handle", () => {
  const list = peopleDirectory(db, { names, canonical });
  assert.deepEqual(list.map((p) => [p.name, p.n]), [["Ann", 11], ["Bob", 2]]); // m16, the attachment-only row, is still a message
  assert.deepEqual([...list[0].chats].sort(), [1, 2, 3, 4]);
  assert.equal(list[0].handle, "15550000001");
  assert.ok(list[0].first < list[0].last);
});

test("an unnamed sender is listed under its handle", () => {
  const list = peopleDirectory(db, { names: new Map(), canonical });
  assert.equal(list[0].name, "+15550000001");
});
