#!/usr/bin/env node
// Voice preview E2E — "hear it before you pick it".
//
// Exercises POST /api/settings/voices/preview end-to-end through the live app:
//   * unknown voice → 400 readable error (provider-agnostic)
//   * openai-compatible provider via a local stub: exact wire format of
//     POST {base}/audio/speech (model/voice/input/speed/response_format,
//     Bearer key), WAV passthrough
//   * server cache: repeat clicks NEVER re-hit upstream (identical bytes,
//     hit count frozen) — per-model cache keys (model switch → new upstream call)
//   * upstream failure → 502 readable error
//   * restore + catalog flip back to zai
//
// Usage: node scripts/test-voice-preview.mjs [--base http://localhost:3000]

import http from "node:http";

const BASE = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "http://localhost:3000";

const PREVIEW_TEXT =
  "Hi! Quick voice preview. If you pick me, this is exactly how I'll narrate your next video — clear, confident, and easy to follow.";

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------- a real, browser-decodable WAV (24 kHz mono 16-bit, 440 Hz, 1.5 s) ----------
function toneWav() {
  const rate = 24000;
  const seconds = 1.5;
  const samples = rate * seconds;
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 2000, (samples - i) / 2000);
    const v = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.4 * fade;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}
const TONE = toneWav();

// ---------- stub upstream ----------
const captured = [];
let failNextFable = true;
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    captured.push({ method: req.method, url: req.url, headers: req.headers, body });
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    if (parsed.voice === "fable" && failNextFable) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub upstream exploded" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(TONE);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body: parsed, raw: text };
}

async function putTts(patch) {
  return json(`${BASE}/api/settings/ai`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(process.env.TF_API_TOKEN ? { Authorization: `Bearer ${process.env.TF_API_TOKEN}` } : {}) },
    body: JSON.stringify({ scope: "capability", capability: "tts", ...patch }),
  });
}

async function postPreview(voice) {
  const res = await fetch(`${BASE}/api/settings/voices/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(process.env.TF_API_TOKEN ? { Authorization: `Bearer ${process.env.TF_API_TOKEN}` } : {}) },
    body: JSON.stringify({ voice }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get("content-type"), buf };
}

const t0 = Date.now();
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;
const stubBase = `http://127.0.0.1:${stubPort}/v1`;
console.log(`stub TTS upstream → ${stubBase}`);

// Snapshot the tts capability so we can restore exactly.
const before = await json(`${BASE}/api/settings/ai`);
const ttsBefore = before.body?.capabilities?.tts ?? null;
const originalVoiceCount = ((await json(`${BASE}/api/settings/voices`)).body?.voices ?? []).length;
console.log(`tts capability before: ${JSON.stringify(ttsBefore)}`);

try {
  // ---------- 1. sanity ----------
  console.log("\n[1] catalog sanity");
  const cat0 = await json(`${BASE}/api/settings/voices`);
  check("GET /api/settings/voices 200", cat0.status === 200);
  check("catalog non-empty", (cat0.body?.voices ?? []).length > 0);

  // ---------- 2. unknown voice → 400 (works under any provider) ----------
  console.log("\n[2] unknown voice");
  const bad = await postPreview("definitely-not-a-voice");
  check("unknown voice → 400", bad.status === 400, `got ${bad.status}`);
  const badJson = JSON.parse(bad.buf.toString("utf8"));
  check(
    "readable error mentions the catalog",
    /not in the active provider's catalog/i.test(badJson.error ?? ""),
    badJson.error ?? ""
  );

  // ---------- 3. point tts at the stub ----------
  console.log("\n[3] switch tts → openai-compatible stub");
  const save = await putTts({ provider: "openai", model: "", baseUrl: stubBase, apiKey: "stub-key-123" });
  check("PUT tts capability 200", save.status === 200, save.raw);
  const cat1 = await json(`${BASE}/api/settings/voices`);
  check("catalog is now openai classic-6", (cat1.body?.voices ?? []).length === 6, JSON.stringify(cat1.body?.voices));
  check("provider reported openai", cat1.body?.provider === "openai");

  // ---------- 4. first preview: wire format ----------
  console.log("\n[4] preview alloy (first click — hits upstream)");
  const hits0 = captured.length;
  const t1 = Date.now();
  const p1 = await postPreview("alloy");
  const firstMs = Date.now() - t1;
  check("alloy → 200", p1.status === 200, `got ${p1.status}`);
  check("Content-Type audio/wav", p1.contentType === "audio/wav", String(p1.contentType));
  check("RIFF magic", p1.buf.subarray(0, 4).toString() === "RIFF");
  check("bytes match stub WAV", p1.buf.equals(TONE), `${p1.buf.length} vs ${TONE.length}`);
  check("exactly one upstream call", captured.length === hits0 + 1, `hits=${captured.length}`);
  const wire = captured[captured.length - 1];
  check("upstream URL is /v1/audio/speech", wire.url.endsWith("/v1/audio/speech"), wire.url);
  check("Bearer key sent", wire.headers.authorization === "Bearer stub-key-123", String(wire.headers.authorization));
  const wb = JSON.parse(wire.body);
  check("body.model defaults to tts-1", wb.model === "tts-1", wb.model);
  check("body.voice === alloy", wb.voice === "alloy", wb.voice);
  check("body.speed === 1", wb.speed === 1, String(wb.speed));
  check("body.response_format === wav", wb.response_format === "wav", wb.response_format);
  check("body.input is the preview line", wb.input === PREVIEW_TEXT, wb.input);
  console.log(`  (first click latency: ${firstMs} ms)`);

  // ---------- 5. cache: repeat click never re-hits upstream ----------
  console.log("\n[5] cache behavior");
  const t2 = Date.now();
  const p2 = await postPreview("alloy");
  const cachedMs = Date.now() - t2;
  check("repeat click → 200", p2.status === 200);
  check("identical bytes", p2.buf.equals(p1.buf));
  check("upstream NOT re-hit", captured.length === 1, `hits=${captured.length}`);
  check("cached click is fast", cachedMs < 1000, `${cachedMs} ms`);

  // ---------- 6. another voice: new upstream call ----------
  console.log("\n[6] preview nova");
  const p3 = await postPreview("nova");
  check("nova → 200", p3.status === 200);
  check("upstream hit for nova", captured.length === 2, `hits=${captured.length}`);
  check("nova voice on wire", JSON.parse(captured[1].body).voice === "nova");

  // ---------- 7. model switch → new cache key → upstream hit ----------
  console.log("\n[7] model switch (gpt-4o-mini-tts)");
  await putTts({ model: "gpt-4o-mini-tts" });
  const cat2 = await json(`${BASE}/api/settings/voices`);
  check("catalog widens beyond classic-6", (cat2.body?.voices ?? []).length > 6, JSON.stringify(cat2.body?.voices));
  const p4 = await postPreview("alloy");
  check("alloy under new model → 200", p4.status === 200);
  check("upstream re-hit (new cache key)", captured.length === 3, `hits=${captured.length}`);
  check("new model on wire", JSON.parse(captured[2].body).model === "gpt-4o-mini-tts");

  // ---------- 8. upstream failure → readable 502 ----------
  console.log("\n[8] upstream failure");
  const t3 = Date.now();
  const p5 = await postPreview("fable");
  const failMs = Date.now() - t3;
  check("fable (stub 500) → 502", p5.status === 502, `got ${p5.status}`);
  const errJson = JSON.parse(p5.buf.toString("utf8"));
  check("readable upstream error", /stub upstream exploded|500/i.test(errJson.error ?? ""), errJson.error ?? "");
  console.log(`  (retried out in ${failMs} ms — ${Math.round(failMs / 1000)}s of backoff)`);
  failNextFable = false;
  const p6 = await postPreview("fable");
  check("fable recovers once stub is healthy", p6.status === 200, `got ${p6.status}`);
} finally {
  // ---------- 9. restore ----------
  console.log("\n[9] restore tts capability");
  if (ttsBefore) {
    const restorePatch = { provider: ttsBefore.provider, model: ttsBefore.model ?? "" };
    if (ttsBefore.baseUrl !== undefined) restorePatch.baseUrl = ttsBefore.baseUrl ?? "";
    if (ttsBefore.apiKey !== undefined) restorePatch.apiKey = ttsBefore.apiKey ?? "";
    const r = await putTts(restorePatch);
    check("tts capability restored", r.status === 200, r.raw);
  }
  const after = await json(`${BASE}/api/settings/voices`);
  check("catalog back to original provider", after.body?.provider === (ttsBefore?.provider ?? "zai"), after.body?.provider);
  check("original voice catalog", (after.body?.voices ?? []).length === originalVoiceCount);
  stub.close();
}

console.log(`\n${passed}/${passed + failed} checks passed in ${Date.now() - t0} ms`);
if (failed) {
  console.log("FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
