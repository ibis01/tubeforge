// Sandbox test: verify TTS + image generation upstream health right now.
import ZAI from "z-ai-web-dev-sdk";

const zai = await ZAI.create();

// Test 1: TTS
console.log("--- TTS test ---");
try {
  const t0 = Date.now();
  const res = await zai.audio.tts.create({
    input: "This is a quick health check of the voice service.",
    voice: "tongtong",
    speed: 1.0,
    response_format: "wav",
    stream: false,
  });
  const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()));
  console.log(`TTS OK: ${buf.length} bytes in ${Date.now() - t0}ms`);
} catch (e) {
  console.log("TTS FAILED:", e.message);
}

// Test 2: Image generation
console.log("--- Image test ---");
try {
  const t0 = Date.now();
  const img = await zai.images.generations.create({
    prompt: "A simple red circle on white background, minimal test image.",
    size: "1344x768",
  });
  const b64 = img.data[0]?.base64;
  const bytes = b64 ? Buffer.from(b64, "base64").length : 0;
  console.log(`Image OK: ${bytes} bytes in ${Date.now() - t0}ms`);
} catch (e) {
  console.log("Image FAILED:", e.message);
}
