// Animated preview E2E — renders ONE scene via CogVideoX image-to-video,
// proving the i2v pipeline (submit → poll → download → compose) works.
// Run: node scripts/test-animated-preview.mjs <videoId>
import fs from "fs";

const BASE = "http://localhost:3000";
const videoId = process.argv[2];
if (!videoId) {
  console.error("usage: node scripts/test-animated-preview.mjs <videoId>");
  process.exit(1);
}
const t0 = Date.now();
const step = (msg) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

step("POST render (animated, sceneLimit=1)");
const res = await fetch(`${BASE}/api/videos/${videoId}/render`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mode: "animated", subtitles: true, music: true, sceneLimit: 1 }),
});
console.log(`  accepted: ${res.status}`);
if (res.status !== 202 && res.status !== 200) {
  console.error(await res.text());
  process.exit(1);
}

step("Polling render progress…");
let lastLabel = "";
for (;;) {
  await sleep(5000);
  const r = await fetch(`${BASE}/api/videos/${videoId}/render`, { cache: "no-store" });
  const d = await r.json();
  if (d.progress && d.progress.label !== lastLabel) {
    lastLabel = d.progress.label;
    step(`  ${d.progress.label} (${d.progress.current}/${d.progress.total})`);
  }
  if (!d.rendering) {
    if (d.error) {
      console.error(`render failed: ${d.error}`);
      process.exit(1);
    }
    break;
  }
}

// Preview written to preview.mp4 — verify it streams
const mp4 = await fetch(`${BASE}/api/videos/${videoId}/mp4?variant=preview`);
console.log(`  GET /mp4?variant=preview: ${mp4.status} ${mp4.headers.get("content-type")} ${mp4.headers.get("content-length")}B`);
if (mp4.status !== 200) process.exit(1);

const buf = Buffer.from(await mp4.arrayBuffer());
fs.writeFileSync("/home/z/my-project/scripts/animated-preview.mp4", buf);
console.log(`\n=== ANIMATED PREVIEW PASSED ===`);
console.log(`preview: ${buf.length} bytes -> scripts/animated-preview.mp4`);
