// Live probe: TTS + CogVideoX i2v submit — verifies upstream services respond NOW.
import ZAI from "z-ai-web-dev-sdk";
import fs from "fs";

const zai = await ZAI.create();

// --- 1) TTS probe ---
console.log("[1] TTS probe...");
try {
  const t0 = Date.now();
  const res = await zai.audio.tts.create({
    input: "This is a live probe of the voice service.",
    voice: "tongtong",
    speed: 1.0,
    response_format: "wav",
    stream: false,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[1] TTS OK in ${Date.now() - t0}ms — ${buf.length} bytes`);
} catch (e) {
  console.log(`[1] TTS FAILED: ${e.message}`);
}

// --- 2) CogVideoX i2v submit probe (full generation takes ~4min) ---
console.log("[2] CogVideoX i2v probe — submitting task...");
const img = "/home/z/my-project/uploads/cmvmttgev0001nfkea594uefv/scene-01.png";
try {
  const t0 = Date.now();
  const b64 = fs.readFileSync(img).toString("base64");
  const submit = await zai.video.generations.create({
    model: "cogvideox-3",
    prompt: "slow cinematic zoom in. Natural ambient motion, cinematic quality, no text.",
    image_url: `data:image/png;base64,${b64}`,
    quality: "speed",
    with_audio: false,
    duration: 5,
    fps: 30,
    size: "1920x1080",
  });
  console.log(`[2] i2v task SUBMITTED in ${Date.now() - t0}ms — id: ${submit.id}`);
  // Poll up to 7 min
  for (let i = 0; i < 42; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const res = await zai.async.result.query(submit.id);
    const status = res.task_status;
    const url = res.video_result?.[0]?.url ?? res.video_url ?? null;
    console.log(`    poll ${i + 1}: status=${status}${url ? " URL ready" : ""}`);
    if (status === "SUCCESS" && url) {
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      fs.writeFileSync("/home/z/my-project/scripts/probe-clip.mp4", buf);
      console.log(`[2] i2v CLIP DOWNLOADED: ${buf.length} bytes -> scripts/probe-clip.mp4`);
      break;
    }
    if (status === "FAIL") { console.log("[2] i2v task FAILED upstream"); break; }
  }
} catch (e) {
  console.log(`[2] i2v FAILED: ${e.message}`);
}
