import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeDb, sample } from "./fixture.mjs";
import { startStub } from "./llm-stub.mjs";

const PORT = 42000 + Math.floor(Math.random() * 3000);
const BASE = `http://127.0.0.1:${PORT}`;
let child, stub;

const get = (p) => fetch(BASE + p).then((r) => r.json());
const getRaw = (p) => fetch(BASE + p);
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

before(async () => {
  stub = await startStub();
  const { path: dbPath, namesPath } = makeDb(sample());
  const data = mkdtempSync(path.join(os.tmpdir(), "messagestats-data-"));
  writeFileSync(path.join(data, "ai.local.json"), JSON.stringify({
    provider: "custom", baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: "stub", apiKey: "x",
  }));
  child = spawn(process.execPath, ["serve.mjs", "--port", String(PORT), "--db", dbPath, "--names", namesPath], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, MESSAGESTATS_DATA: data, MESSAGESTATS_PERSON_FLOOR: "1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i += 1) {
    try { await fetch(`${BASE}/api/ping`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server never came up");
});
after(async () => { child?.kill(); await stub?.close(); });

test("people and person endpoints", async () => {
  const people = await get("/api/people");
  assert.equal(people[0].name, "Ann");
  const d = await get("/api/person?handle=15550000001");
  assert.equal(d.person.total, 11);
  assert.equal((await getRaw("/api/person?handle=19999999999")).status, 404);
});

test("overview people carry their handle", async () => {
  const O = await get("/api/overview");
  assert.equal(O.people[0].handle, "15550000001");
});

test("person ask sends excerpts and the scope line", async () => {
  const r = await post("/api/ai/ask", { scope: "person", handle: "15550000001", question: "what did Ann say about coming over" });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.chatId, "person:Ann");
  assert.equal(r.chat, "Ann");
  assert.ok(r.excerptChars > 0);
  const user = stub.last.messages.find((m) => m.role === "user").content;
  assert.match(user, /EXCERPTS — \d+ real messages by Ann/);
  assert.match(user, /SEARCH "coming"/);
  assert.match(user, /coming over/);
  assert.match(user, /PER THREAD/);
  assert.match(stub.last.messages[0].content, /one person across every iMessage conversation/);
});

test("chat ask now carries excerpts too", async () => {
  const r = await post("/api/ai/ask", { chatId: 2, merge: true, question: "roast them" });
  assert.equal(r.error, undefined, r.error);
  assert.ok(r.excerptChars > 0);
  const user = stub.last.messages.find((m) => m.role === "user").content;
  assert.match(user, /EXCERPTS — \d+ real messages from this conversation/);
  assert.match(user, /me obviously/);
  assert.match(stub.last.messages[0].content, /chosen subset of real messages/);
});

test("a person below the floor everywhere is refused with a message", async () => {
  // Floor 1 is in force for this server, so pick someone with nothing at all.
  const r = await post("/api/ai/ask", { scope: "person", handle: "19999999999", question: "hi" });
  assert.match(r.error, /no messages|nothing to read/);
});
