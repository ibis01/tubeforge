// Quick synchronous TTS + LLM probe with hard timeouts.
import ZAI from "z-ai-web-dev-sdk";

const zai = await ZAI.create();

async function withTimeout(label, promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms`)), ms); });
  try {
    const r = await Promise.race([promise, timeout]);
    console.log(`[${label}] OK`);
    return r;
  } catch (e) {
    console.log(`[${label}] FAILED: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 1) LLM probe
const t0 = Date.now();
const llm = await withTimeout("llm", zai.chat.completions.create({
  messages: [{ role: "user", content: "Reply with the single word: ok" }],
  thinking: { type: "disabled" },
}), 60_000);
console.log(`  llm latency ${Date.now() - t0}ms, reply: ${llm?.choices?.[0]?.message?.content?.slice(0, 40) ?? "n/a"}`);

// 2) TTS probe x2 (checks rate limiting on back-to-back calls)
for (let i = 1; i <= 2; i++) {
  const t = Date.now();
  const res = await withTimeout(`tts #${i}`, zai.audio.tts.create({
    input: `Probe number ${i}. The animated video pipeline must work end to end.`,
    voice: "tongtong",
    speed: 1.0,
    response_format: "wav",
    stream: false,
  }), 90_000);
  if (res) {
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`  tts #${i} latency ${Date.now() - t}ms, ${buf.length} bytes`);
  }
}
console.log("probe done");
