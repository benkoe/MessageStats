/**
 * Provider-agnostic LLM client. Zero dependencies, raw HTTP, bring your own key.
 *
 * The assistant is the ONE part of this project that can send data off the
 * machine, so it is off unless you configure it, and everything it sends is
 * logged locally to ai-sent.local.jsonl so you can audit exactly what left.
 *
 * Three adapters cover almost everything:
 *
 *   openai   POST /v1/chat/completions — the de-facto standard. OpenAI, Groq,
 *            Together, OpenRouter, DeepSeek, xAI, Mistral… AND Ollama and
 *            LM Studio, which serve the same shape on localhost. Local models
 *            are not a separate feature; they are this adapter with a
 *            different baseUrl and no key.
 *   anthropic  POST /v1/messages — its own shape (x-api-key, anthropic-version).
 *   gemini     POST /v1beta/models/<model>:generateContent — its own again.
 *
 * Config lives in ai.local.json (gitignored) or the environment:
 *
 *   { "provider": "ollama", "model": "llama3.1" }                    // local, no key
 *   { "provider": "anthropic", "model": "claude-opus-5", "apiKey": "sk-ant-…" }
 *   { "provider": "openai", "model": "…", "apiKey": "sk-…" }
 *   { "provider": "custom", "baseUrl": "https://…/v1", "model": "…", "apiKey": "…" }
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

/* ---------------- presets ---------------- */

/**
 * `wire` picks the request/response shape; `baseUrl` is only a default. Any
 * OpenAI-compatible endpoint works by setting provider "custom" with a baseUrl.
 */
export const PROVIDERS = {
  anthropic:  { label: "Anthropic (Claude)", wire: "anthropic", baseUrl: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", needsKey: true,  local: false, hint: "claude-opus-5" },
  openai:     { label: "OpenAI (ChatGPT)",   wire: "openai", baseUrl: "https://api.openai.com/v1",    keyEnv: "OPENAI_API_KEY",    needsKey: true,  local: false, hint: "a chat model id" },
  gemini:     { label: "Google Gemini",      wire: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyEnv: "GEMINI_API_KEY", needsKey: true, local: false, hint: "a Gemini model id" },
  groq:       { label: "Groq",               wire: "openai", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY",    needsKey: true,  local: false, hint: "a Groq model id" },
  openrouter: { label: "OpenRouter",         wire: "openai", baseUrl: "https://openrouter.ai/api/v1",  keyEnv: "OPENROUTER_API_KEY", needsKey: true, local: false, hint: "vendor/model" },
  deepseek:   { label: "DeepSeek",           wire: "openai", baseUrl: "https://api.deepseek.com/v1",   keyEnv: "DEEPSEEK_API_KEY",  needsKey: true,  local: false, hint: "a DeepSeek model id" },
  mistral:    { label: "Mistral",            wire: "openai", baseUrl: "https://api.mistral.ai/v1",     keyEnv: "MISTRAL_API_KEY",   needsKey: true,  local: false, hint: "a Mistral model id" },
  ollama:     { label: "Ollama (local)",     wire: "openai", baseUrl: "http://127.0.0.1:11434/v1",     keyEnv: null, needsKey: false, local: true, hint: "llama3.1, qwen2.5, …" },
  lmstudio:   { label: "LM Studio (local)",  wire: "openai", baseUrl: "http://127.0.0.1:1234/v1",      keyEnv: null, needsKey: false, local: true, hint: "whatever you loaded" },
  custom:     { label: "Custom (OpenAI-compatible)", wire: "openai", baseUrl: null, keyEnv: null, needsKey: false, local: false, hint: "set baseUrl + model" },
};

/* ---------------- config ---------------- */

export function loadConfig(dir) {
  const file = path.join(dir, "ai.local.json");
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(readFileSync(file, "utf8")); }
    catch (err) { return { error: `ai.local.json is not valid JSON: ${err.message}` }; }
  }
  const provider = cfg.provider ?? process.env.IMSTATS_AI_PROVIDER ?? null;
  if (!provider) return { configured: false };
  const preset = PROVIDERS[provider];
  if (!preset) return { error: `unknown provider "${provider}"` };

  const key = cfg.apiKey ?? (preset.keyEnv ? process.env[preset.keyEnv] : null) ?? null;
  const baseUrl = cfg.baseUrl ?? preset.baseUrl;
  const model = cfg.model ?? process.env.IMSTATS_AI_MODEL ?? null;

  if (preset.needsKey && !key) return { error: `${preset.label} needs an API key (ai.local.json "apiKey", or $${preset.keyEnv})` };
  if (!baseUrl) return { error: `provider "${provider}" needs a "baseUrl"` };
  if (!model) return { error: `provider "${provider}" needs a "model" (e.g. ${preset.hint})` };

  return { configured: true, provider, label: preset.label, wire: preset.wire, local: preset.local, baseUrl, model, key, file };
}

/* ---------------- wire adapters ---------------- */

const build = {
  /** OpenAI-compatible — also Ollama, LM Studio, Groq, OpenRouter, … */
  openai: (c, { system, user, maxTokens }) => ({
    url: `${c.baseUrl.replace(/\/$/, "")}/chat/completions`,
    headers: c.key ? { authorization: `Bearer ${c.key}` } : {},
    body: {
      model: c.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    },
    read: (j) => j.choices?.[0]?.message?.content ?? "",
    truncated: (j) => j.choices?.[0]?.finish_reason === "length",
  }),

  anthropic: (c, { system, user, maxTokens }) => ({
    url: `${c.baseUrl.replace(/\/$/, "")}/v1/messages`,
    headers: { "x-api-key": c.key, "anthropic-version": "2023-06-01" },
    body: {
      model: c.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    },
    // content is a list of blocks; only text blocks are ours to read.
    read: (j) => (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""),
    // A safety classifier can decline with HTTP 200 — check before reading content.
    refusal: (j) => (j.stop_reason === "refusal" ? (j.stop_details?.explanation || "the model declined this request") : null),
    truncated: (j) => j.stop_reason === "max_tokens",
  }),

  gemini: (c, { system, user, maxTokens }) => ({
    url: `${c.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(c.model)}:generateContent`,
    headers: { "x-goog-api-key": c.key },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    },
    read: (j) => (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(""),
    truncated: (j) => j.candidates?.[0]?.finishReason === "MAX_TOKENS",
  }),
};

/* ---------------- model discovery ---------------- */

/**
 * Ask the provider what models it has, so nobody has to type a model id from
 * memory — and so this file never carries a hardcoded list that goes stale.
 * Every provider exposes one; the path and the response shape differ.
 */
export async function listModels({ wire, baseUrl, key, label, local }) {
  const base = String(baseUrl ?? "").replace(/\/$/, "");
  const spec = {
    openai:    { url: `${base}/models`,    headers: key ? { authorization: `Bearer ${key}` } : {},
                 read: (j) => (j.data ?? []).map((m) => m.id) },
    anthropic: { url: `${base}/v1/models`, headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
                 read: (j) => (j.data ?? []).map((m) => m.id) },
    gemini:    { url: `${base}/models`,    headers: { "x-goog-api-key": key },
                 // Gemini returns "models/<id>" and includes non-chat models.
                 read: (j) => (j.models ?? [])
                   .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
                   .map((m) => m.name.replace(/^models\//, "")) },
  }[wire];

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  let res;
  try {
    res = await fetch(spec.url, { headers: spec.headers, signal: ctl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (local) throw new Error(`Couldn't reach ${label} at ${baseUrl} — is it running?`);
    throw new Error(`${label}: ${err.name === "AbortError" ? "timed out" : err.message}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${label} returned non-JSON (${res.status})`); }
  if (!res.ok) throw new Error(`${label} ${res.status}: ${json.error?.message ?? text.slice(0, 160)}`);
  const models = spec.read(json).sort();
  if (!models.length) throw new Error(local ? `${label} has no models pulled yet — try \`ollama pull llama3.1\`` : `${label} returned no models`);
  return models;
}

/* ---------------- call ---------------- */

/**
 * One request, one answer. `logDir` gets an append-only record of exactly what
 * was sent — the point of the feature is that you can check.
 */
export async function ask(cfg, { system, user, maxTokens = 2048, logDir, timeoutMs = 180_000 }) {
  const spec = build[cfg.wire](cfg, { system, user, maxTokens });

  if (logDir) {
    try {
      appendFileSync(path.join(logDir, "ai-sent.local.jsonl"),
        JSON.stringify({ at: new Date().toISOString(), provider: cfg.provider, model: cfg.model,
          url: spec.url, local: cfg.local, chars: system.length + user.length, system, user }) + "\n");
    } catch { /* logging must never break the request */ }
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(spec.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...spec.headers },
      body: JSON.stringify(spec.body),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`${cfg.label} timed out after ${timeoutMs / 1000}s`);
    // A local server that isn't running is the single most common failure.
    if (cfg.local) throw new Error(`Couldn't reach ${cfg.label} at ${cfg.baseUrl} — is it running?`);
    throw new Error(`${cfg.label}: ${err.message}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${cfg.label} returned non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) {
    const msg = json.error?.message ?? json.error?.type ?? json.message ?? text.slice(0, 200);
    throw new Error(`${cfg.label} ${res.status}: ${msg}`);
  }
  const declined = spec.refusal?.(json);
  if (declined) throw new Error(`${cfg.label} declined: ${declined}`);

  const out = spec.read(json);
  if (!out) throw new Error(`${cfg.label} returned an empty response`);
  // An answer that stopped at the token ceiling looks identical to a finished
  // one — it just ends mid-sentence. Report it rather than letting the caller
  // present a half answer as the whole answer.
  return { text: out, truncated: spec.truncated?.(json) === true };
}
