/**
 * A fake OpenAI-compatible provider: answers every chat completion with the
 * start of the prompt it was sent, and remembers the last request body so a
 * test can assert on what would have left the machine. Nothing is billed.
 *
 * In a test: `const stub = await startStub(); stub.last; stub.close()`.
 * By hand, for the UI: `node test/llm-stub.mjs 4310` and point ai.local.json's
 * provider "custom" at http://127.0.0.1:4310/v1 with any model name.
 */
import { createServer } from "node:http";

export function startStub(port = 0, { delayMs = 0 } = {}) {
  const state = { last: null, calls: 0, port: null, close: null };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "stub" }] }));
      }
      const j = JSON.parse(body || "{}");
      state.last = j;
      state.calls += 1;
      const user = j.messages?.find((m) => m.role === "user")?.content ?? "";
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: `STUB: ${user.slice(0, 200)}` }, finish_reason: "stop" }] }));
      }, delayMs);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    state.port = server.address().port;
    state.close = () => new Promise((r) => server.close(r));
    resolve(state);
  }));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const s = await startStub(Number(process.argv[2] ?? 4310), { delayMs: Number(process.argv[3] ?? 0) });
  console.log(`stub provider on http://127.0.0.1:${s.port}/v1`);
}
