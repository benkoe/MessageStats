import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { snapshot } from "./golden/snapshot.mjs";

for (const chat of [1, 2]) {
  test(`analyze() perPerson matches the golden snapshot for chat ${chat}`, () => {
    const want = JSON.parse(readFileSync(new URL(`./golden/analyze-${chat}.json`, import.meta.url), "utf8"));
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot(chat))), want);
  });
}
