import { loadIdentities } from "../../lib.mjs";
import { analyze, loadMessages, resolveChats, resolveMe } from "../../analyze.mjs";
import { makeDb, sample } from "../fixture.mjs";

export const FIELDS = ["who", "n", "byYear", "peakHour", "night", "hours", "avgLen", "medianLen", "maxLen",
  "starts", "lastWord", "medianReply", "doubles", "laughs", "questions", "vocab", "topWords", "topEmoji"];

/** perPerson (the fields personStats will own) plus signature, for one fixture chat, merged. */
export function snapshot(chatId) {
  const { db, namesPath } = makeDb(sample());
  const { names, canonical } = loadIdentities(namesPath, db);
  const resolved = resolveChats(db, { chatId, merge: true, canonical });
  const meName = resolveMe(db, resolved.ids, { names, canonical });
  const { msgs, byGuid, label } = loadMessages(db, resolved.ids, { names, canonical, meName });
  const A = analyze(db, { ids: resolved.ids, msgs, byGuid, label, chat: resolved.chat, names, canonical });
  return {
    perPerson: A.perPerson.map((p) => Object.fromEntries(FIELDS.map((f) => [f, p[f]]))),
    signature: A.signature,
  };
}
