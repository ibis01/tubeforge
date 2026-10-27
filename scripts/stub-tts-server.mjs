#!/usr/bin/env node
// Persistent OpenAI-compatible TTS stub for BROWSER testing of voice previews.
// POST /v1/audio/speech → real decodable WAV (440 Hz tone). GET /__hits → count.
// Usage: node scripts/stub-tts-server.mjs [port]
import http from "node:http";

const port = Number(process.argv[2] ?? 3973);
let hits = 0;

function toneWav(freq) {
  const rate = 24000;
  const seconds = 1.2;
  const samples = rate * seconds;
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 2000, (samples - i) / 2000);
    const v = Math.sin((2 * Math.PI * freq * i) / rate) * 0.4 * fade;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}
// Distinct pitch per voice so a listener can tell them apart.
const TONES = new Map([["alloy", 330], ["echo", 392], ["fable", 440], ["onyx", 294], ["nova", 494], ["shimmer", 550]]);

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/__hits") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hits }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits += 1;
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      console.log(`[tts-stub] ${req.method} ${req.url} voice=${parsed.voice} hit=${hits}`);
      const buf = toneWav(TONES.get(parsed.voice) ?? 440);
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(buf);
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`[tts-stub] listening on http://127.0.0.1:${port}/v1`));
