// Verify video generation works: submit async task, poll for result.
import fs from "fs";
import ZAI from "z-ai-web-dev-sdk";

const zai = await ZAI.create();
const t0 = Date.now();

// Submit an image-to-video task: use the existing thumbnail as the keyframe.
const keyframe = fs.readFileSync("/home/z/my-project/uploads/cmvmkvtk60019ritgszq7zl0w/thumbnail.png").toString("base64");
const submit = await zai.video.generations.create({
  model: "cogvideox-3",
  prompt: "Slow cinematic push-in, fireflies drifting gently, moss swaying in a soft breeze, magical forest atmosphere",
  image_url: `data:image/png;base64,${keyframe}`,
  quality: "speed",
  with_audio: false,
  duration: 5,
  fps: 30,
  size: "1920x1080",
});
console.log(`task submitted: id=${submit.id} status=${submit.task_status} (${Date.now() - t0}ms)`);

// Poll for completion (up to 8 min)
for (let i = 0; i < 32; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const res = await zai.async.result.query(submit.id);
  const status = res.task_status;
  const url = res.video_result?.[0]?.url ?? res.video_url ?? null;
  if (status === "SUCCESS" && url) {
    console.log(`SUCCESS after ${Math.round((Date.now() - t0) / 1000)}s`);
    console.log(`video url: ${url.slice(0, 120)}...`);
    // Download to verify it's real video bytes
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    fs.writeFileSync("/home/z/my-project/scripts/test-clip.mp4", buf);
    console.log(`downloaded: ${buf.length} bytes -> scripts/test-clip.mp4`);
    process.exit(0);
  }
  if (status === "FAIL") {
    console.log(`FAILED after ${Math.round((Date.now() - t0) / 1000)}s:`, JSON.stringify(res).slice(0, 300));
    process.exit(1);
  }
  if (i % 2 === 0) console.log(`  ...${status} (${Math.round((Date.now() - t0) / 1000)}s)`);
}
console.log("TIMEOUT after 8 min");
process.exit(2);
