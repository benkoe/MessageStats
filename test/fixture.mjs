/**
 * A synthetic chat.db for tests.
 *
 * Just enough of Apple's schema for lib.mjs / analyze.mjs to run: the
 * columns the queries name, nullable, with the dates in nanoseconds since
 * 2001 as the real thing stores them. Times in a spec are local-clock
 * notation ("2023-01-10T10:00") and are built with new Date(y, m, d, h, mi),
 * never Date.parse(), so the tests mean the same thing in every timezone.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const APPLE_EPOCH_MS = 978_307_200_000;

/** Local-clock notation → Apple nanoseconds, as a BigInt. */
export function ns(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(at);
  if (!m) throw new Error(`bad fixture time ${at}`);
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return BigInt(d.getTime() - APPLE_EPOCH_MS) * 1_000_000n;
}

const SCHEMA = `
create table handle (ROWID integer primary key, id text);
create table chat (ROWID integer primary key, guid text, chat_identifier text, display_name text,
  style integer, original_group_id text);
create table chat_handle_join (chat_id integer, handle_id integer);
create table message (ROWID integer primary key, guid text, text text, attributedBody blob,
  date integer, is_from_me integer default 0, handle_id integer, destination_caller_id text,
  associated_message_type integer default 0, associated_message_guid text,
  associated_message_emoji text, item_type integer default 0, group_action_type integer default 0,
  group_title text, other_handle integer, date_read integer default 0, date_delivered integer default 0,
  thread_originator_guid text, balloon_bundle_id text, cache_has_attachments integer default 0);
create table chat_message_join (chat_id integer, message_id integer);
create table attachment (ROWID integer primary key, mime_type text, uti text, transfer_name text,
  total_bytes integer, is_sticker integer default 0);
create table message_attachment_join (message_id integer, attachment_id integer);
`;

export function makeDb(spec) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "messagestats-test-"));
  const dbPath = path.join(dir, "chat.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const ins = {
    handle: db.prepare("insert into handle (ROWID, id) values (?, ?)"),
    chat: db.prepare("insert into chat (ROWID, guid, chat_identifier, display_name, style, original_group_id) values (?, ?, ?, ?, ?, ?)"),
    chj: db.prepare("insert into chat_handle_join (chat_id, handle_id) values (?, ?)"),
    msg: db.prepare(`insert into message (ROWID, guid, text, date, is_from_me, handle_id, destination_caller_id,
      associated_message_type, associated_message_guid, item_type) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    cmj: db.prepare("insert into chat_message_join (chat_id, message_id) values (?, ?)"),
  };
  for (const [rowid, id] of Object.entries(spec.handles)) ins.handle.run(Number(rowid), id);
  for (const c of spec.chats) {
    ins.chat.run(c.id, `chat-${c.id}`, c.ci, c.dn ?? null, c.style, c.ogid ?? null);
    for (const h of c.roster ?? []) ins.chj.run(c.id, h);
  }
  const oneToOne = new Map(spec.chats.filter((c) => c.style !== 43 && (c.roster ?? []).length === 1).map((c) => [c.id, c.roster[0]]));
  for (const m of spec.messages) {
    const me = m.from === "me";
    // Real libraries: an outgoing message in a 1:1 chat carries the
    // counterpart's handle_id. Only group sends have none. A query that
    // forgets is_from_me credits the owner's messages to the other person.
    const handleId = me ? (oneToOne.get(m.chat) ?? null) : m.from;
    ins.msg.run(m.id, `m${m.id}`, m.text ?? null, ns(m.at), me ? 1 : 0, handleId,
      me ? spec.me : null, m.amt ?? 0, m.target ?? null, m.item ?? 0);
    ins.cmj.run(m.chat, m.id);
  }
  const namesPath = path.join(dir, "names.json");
  writeFileSync(namesPath, JSON.stringify({ names: spec.names, aliases: {} }, null, 2));
  return { path: dbPath, dir, db, namesPath };
}

/** The scenario every test asserts against. See the plan for the tallies. */
export function sample() {
  return {
    me: "+15550000000",
    handles: { 1: "+15550000001", 2: "+15550000002", 3: "+15550000003" },
    names: { "15550000001": "Ann", "15550000002": "Bob", "15550000003": "Cal" },
    chats: [
      { id: 1, ci: "+15550000001", style: 45, roster: [1] },
      { id: 2, ci: "chat999", style: 43, dn: "Crew", roster: [1, 2] },
      { id: 3, ci: "SMS;-;+15550000001", style: 45, roster: [1] },
      { id: 4, ci: "chat888", style: 43, dn: "Crew", roster: [1, 3] },
    ],
    messages: [
      { id: 1, chat: 1, from: 1, at: "2023-01-10T10:00", text: "hey are you around?" },
      { id: 2, chat: 1, from: "me", at: "2023-01-10T10:01", text: "yes lol" },
      { id: 3, chat: 1, from: 1, at: "2023-01-10T10:02", text: "ok cool" },
      { id: 4, chat: 1, from: 1, at: "2023-01-10T10:03", text: "coming over" },
      { id: 5, chat: 1, from: 1, at: "2024-03-05T22:00", text: "this is the longest message ann has ever written in this fixture, truly" },
      { id: 6, chat: 1, from: "me", at: "2024-03-05T22:30", text: "haha" },
      { id: 7, chat: 3, from: 1, at: "2022-06-01T09:00", text: "old sms thread" },
      { id: 8, chat: 2, from: 2, at: "2023-05-01T12:00", text: "who's in" },
      { id: 9, chat: 2, from: 1, at: "2023-05-01T12:01", text: "me obviously" },
      { id: 10, chat: 2, from: 2, at: "2023-05-01T12:02", text: "lmao" },
      { id: 11, chat: 2, from: 1, at: "2023-05-02T12:00", text: "coming over" },
      { id: 12, chat: 2, from: 1, at: "2023-05-02T14:00", text: "anyone?" },
      { id: 13, chat: 2, from: 1, at: "2023-05-03T09:00", text: "ok" },
      { id: 14, chat: 2, from: "me", at: "2024-01-01T00:30", text: "happy new year" },
      { id: 15, chat: 4, from: 1, at: "2023-06-01T10:00", text: "crew sms" },
      { id: 16, chat: 2, from: 1, at: "2023-05-04T10:00", text: "￼" },
      // tapbacks, in chat 2
      { id: 101, chat: 2, from: 2, at: "2023-05-01T12:03", amt: 2003, target: "p:0/m9" },
      { id: 102, chat: 2, from: "me", at: "2023-05-01T12:04", amt: 2000, target: "p:0/m9" },
      { id: 103, chat: 2, from: 2, at: "2023-05-02T12:05", amt: 2000, target: "p:0/m11" },
      { id: 104, chat: 2, from: 2, at: "2023-05-02T12:06", amt: 3000, target: "p:0/m11" },
      { id: 105, chat: 2, from: 2, at: "2023-05-04T10:01", amt: 2000, target: "p:0/m16" },
      { id: 106, chat: 2, from: "me", at: "2023-05-04T10:02", amt: 2003, target: "p:0/m16" },
    ],
  };
}
