// Run once to (re)write the golden perPerson snapshots. Deliberately a
// separate script: the test must never be able to overwrite its own answer.
import { writeFileSync } from "node:fs";
import { snapshot } from "./snapshot.mjs";
for (const chat of [1, 2]) writeFileSync(new URL(`./analyze-${chat}.json`, import.meta.url), JSON.stringify(snapshot(chat), null, 2));
console.log("golden written");
