#!/usr/bin/env node
/**
 * The VoiceStudio adapter LIVE-SHAPE test — S121's Next-Action follow-up.
 *
 *   node --import tsx scripts/test-voicestudio-adapter.mts
 *
 * What this proves: TubeForge's REAL adapters (providers/tts.ts
 * ttsSynthesize and providers/asr.ts asrTranscribeDetailed) speak the
 * VoiceStudio wire contract end-to-end — through the actual providerFetch
 * path (timeouts, headers, form building, parsing), not a mocked adapter.
 *
 * What this is NOT: it drives a VoiceStudio-SHAPED loopback service (a
 * minimal OpenAI-compatible mock serving /v1/audio/speech + /v1/audio/
 * transcriptions), not the real GPU server. The live-service acceptance
 * rows (word-timing accuracy vs the whisperx reference; real synthesis
 * quality) stay recorded as defer gates — they need a running VoiceStudio
 * instance and are the operator's lane. This script proves the ADAPTER's
 * half of that contract is real.
 *
 * The contract asserted here is the audited one (S121 P0):
 *   POST {baseUrl}/v1/audio/speech      { model, input, voice, speed,
 *                                         response_format: "wav" } → WAV bytes
 *   POST {baseUrl}/v1/audio/transcriptions
 *         multipart: file, model, response_format=verbose_json,
 *                    timestamp_granularities[]=word
 *         → { text, words: [{ word, start, end }] }   (flat words[] — the
 *           VoiceStudio shape; the parser also tolerates OpenAI's nested
 *           segments[].words, pinned in the unit suite)
 */

import http from "node:http";
import { ttsSynthesize } from "../src/lib/tubeforge/providers/tts";
import { asrTranscribeDetailed, type AsrWord } from "../src/lib/tubeforge/providers/asr";
import { buildMouthBeats, mouthAt, wordSpansFromAsr } from "../src/lib/tubeforge/characters/rig-frame";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: unknown, msg: string): asserts cond {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function eq<T>(actual: T, expected: T, label = "value"): void {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

/** A minimal valid WAV (44-byte canonical header + 800 PCM16 mono samples
 *  of a 440 Hz tone at 16 kHz) — long enough to pass the adapter's
 *  length check (>44 bytes), small enough to keep this test instant. */
function minimalWav(): Buffer {
  const sampleRate = 16000;
  const samples = 800;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(3000 * Math.sin((i / sampleRate) * 440 * 2 * Math.PI)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

interface SpeechReceipt {
  model?: string;
  input?: string;
  voice?: string;
  speed?: number;
  response_format?: string;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// The audited word stream — deterministic, ascending, finite.
const MOCK_WORDS: AsrWord[] = [
  { word: "Hello", start: 0.0, end: 0.32 },
  { word: "from", start: 0.32, end: 0.5 },
  { word: "the", start: 0.5, end: 0.62 },
  { word: "mock", start: 0.62, end: 0.9 },
  { word: "studio", start: 0.9, end: 1.4 },
];

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "";
  if (req.method === "POST" && url.endsWith("/v1/audio/speech")) {
    const body = await readBody(req);
    let receipt: SpeechReceipt = {};
    try {
      receipt = JSON.parse(body.toString("utf8")) as SpeechReceipt;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "the speech body was not JSON" } }));
      return;
    }
    (server as http.Server & { __speechReceipt?: SpeechReceipt }).__speechReceipt = receipt;
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(minimalWav());
    return;
  }
  if (req.method === "POST" && url.endsWith("/v1/audio/transcriptions")) {
    const body = await readBody(req);
    (server as http.Server & { __asrBody?: string }).__asrBody = body.toString("latin1");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: MOCK_WORDS.map((w) => w.word).join(" "), words: MOCK_WORDS }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url}` } }));
});

function listen(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("the mock server did not report a port"));
    });
  });
}

const port = await listen();
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`S122 — the VoiceStudio adapter live-shape test (mock at ${baseUrl})\n`);

// ---------------------------------------------------------------------
// 1. TTS — the REAL adapter against the REAL wire path.
// ---------------------------------------------------------------------
try {
  const overrides = {
    provider: "voicestudio" as const,
    model: "voxcpm2",
    baseUrl,
    apiKey: "",
  };
  const wav = await ttsSynthesize(
    { input: "Hello from VoiceStudio", voice: "Nova", speed: 1 },
    overrides,
  );
  ok(wav.length > 44, "the synthesis returned audio bytes (past the 44-byte floor)");
  eq(wav.toString("latin1", 0, 4), "RIFF", "the bytes are a WAV (RIFF header)");
  const receipt = (server as http.Server & { __speechReceipt?: SpeechReceipt }).__speechReceipt;
  ok(Boolean(receipt), "the speech route received a request");
  eq(receipt?.model, "voxcpm2", "the request carries the configured engine id");
  eq(receipt?.input, "Hello from VoiceStudio", "the narration rides verbatim");
  eq(receipt?.voice, "Nova", "the voice passes through VERBATIM (the server owns the catalog)");
  eq(receipt?.response_format, "wav", "response_format is wav (the downstream merge contract)");
  ok(typeof receipt?.speed === "number" && receipt.speed === 1, "the speed rides the audited range");
  ok(receipt !== undefined && !("timestamp_granularities" in receipt), "no ASR fields leak into the speech body");

  // -------------------------------------------------------------------
  // 2. ASR — the detailed pass (words), through the same wire path.
  // -------------------------------------------------------------------
  const detailed = await asrTranscribeDetailed(minimalWav(), {
    provider: "voicestudio",
    model: "whisperx",
    baseUrl,
    apiKey: "",
  });
  eq(detailed.provider, "voicestudio", "the detailed pass reports its provider");
  eq(detailed.text, MOCK_WORDS.map((w) => w.word).join(" "), "the transcript is the mock's five words");
  ok(Array.isArray(detailed.words) && detailed.words.length === 5, "five measured word spans came back");
  ok(
    detailed.words.every((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start),
    "every span is finite and ascending",
  );
  ok(detailed.words[0].word === "Hello" && detailed.words[0].start === 0, "the first span carries the first word");
  const asrBody = (server as http.Server & { __asrBody?: string }).__asrBody ?? "";
  ok(asrBody.includes('name="model"'), "the transcription form carries a model field");
  ok(asrBody.includes("whisperx"), "the form names the whisperx engine");
  ok(asrBody.includes("verbose_json"), "response_format is verbose_json (the word-timing shape)");
  ok(asrBody.includes("timestamp_granularities") && asrBody.includes("word"), "word granularity is requested");
  ok(asrBody.includes("chunk.wav"), "the audio rides as chunk.wav (the adapter's fixture name)");

  // -------------------------------------------------------------------
  // 3. The measured rung flows into the K1 mouth schedule — one stream,
  //    two consumers, no re-alignment.
  // -------------------------------------------------------------------
  const spans = wordSpansFromAsr(detailed.words);
  eq(spans.length, 5, "the measured stream lands in ms");
  eq(spans[0].endMs, 320, "0.32 s → 320 ms (the same rounding both consumers share)");
  const beats = buildMouthBeats(spans);
  ok(beats.length > 0, "the schedule builds from the adapter's words");
  ok(
    beats.every((b) => {
      const word = spans.find((s) => b.startMs >= s.startMs && b.endMs <= s.endMs);
      return Boolean(word);
    }),
    "every beat rides inside a measured word span",
  );
  eq(mouthAt(beats, spans[0].startMs + 5), "open", "the first word opens on cue");
  eq(mouthAt(beats, -1), "closed", "before the stream reads closed");
} catch (err) {
  failed += 1;
  failures.push(`the live-shape run threw: ${err instanceof Error ? err.message : String(err)}`);
  console.log(`  ✗ the live-shape run threw: ${err instanceof Error ? err.message : String(err)}`);
}

server.close();

console.log(`\n${passed} passed, ${failed} failed${failures.length ? ":" : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failed > 0 ? 1 : 0);
