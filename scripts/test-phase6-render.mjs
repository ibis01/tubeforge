// Continuation: wait storyboard → animated render (scene 1) → assert MP4.
// Foreground-friendly; the render job survives even if this script is killed.
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
const probeFile = promisify(execFile);

const BASE = "http://localhost:3000";
const VIDEO_ID = "cmvmyynva000roxpufl6yx7jg";
const UPLOADS = "/home/z/my-project/uploads";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function video() {
  const res = await fetch(`${BASE}/api/videos/${VIDEO_ID}`, { cache: "no-store" });
  return (await res.json()).video;
}

async function probe(file) {
  const out = JSON.parse((await probeFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_name,width,height", "-of", "json", file])).stdout);
  return { duration: Number(out.format?.duration ?? 0), streams: out.streams ?? [] };
}

let pass = 0, fail = 0;
const ok = (c, l) => { console.log(`${c ? "  ✓" : "  ✗"} ${l}`); c ? pass++ : fail++; };

// 1) wait storyboard
let v = await video();
if (!v.hasStoryboard) {
  console.log("[1] waiting for storyboard job…");
  const deadline = Date.now() + 9 * 60_000;
  while (!v.hasStoryboard && Date.now() < deadline) {
    if (v.error) throw new Error(v.error);
    process.stdout.write(`    painting… ${Math.round((Date.now() - deadline + 9 * 60_000) / 1000)}s\r`);
    await sleep(5000);
    v = await video();
  }
}
ok(v.hasStoryboard, `storyboard complete (${(v.scenes ?? []).length} scenes)`);

// 2) animated render of scene 1
console.log("[2] POST /render {mode:animated, sceneLimit:1}");
const post = await fetch(`${BASE}/api/videos/${VIDEO_ID}/render`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mode: "animated", sceneLimit: 1, subtitles: true, music: true }),
});
const pbody = await post.json().catch(() => ({}));
console.log(`    -> HTTP ${post.status} ${JSON.stringify(pbody)}`);

const t0 = Date.now();
let rendering = true, lastLabel = "";
const deadline = Date.now() + 9.5 * 60_000;
while (rendering && Date.now() < deadline) {
  const res = await fetch(`${BASE}/api/videos/${VIDEO_ID}/render`, { cache: "no-store" });
  const st = await res.json();
  rendering = st.rendering;
  const label = st.progress?.label;
  if (label && label !== lastLabel) { lastLabel = label; console.log(`    [${Math.round((Date.now() - t0) / 1000)}s] ${label}`); }
  if (!rendering && st.error) { console.log(`    ✗ render error: ${st.error}`); fail++; break; }
  if (rendering) await sleep(5000);
}
if (!rendering) ok(true, `render finished in ${Math.round((Date.now() - t0) / 1000)}s`);

const preview = path.join(UPLOADS, VIDEO_ID, "preview.mp4");
ok(fs.existsSync(preview), "preview.mp4 exists");
if (fs.existsSync(preview)) {
  const info = await probe(preview);
  const vid = info.streams.find((s) => s.codec_name === "h264");
  ok(vid && info.duration > 2, `h264 ${vid?.width}x${vid?.height}, ${info.duration.toFixed(1)}s`);
  ok(info.streams.some((s) => s.codec_name === "aac"), "aac narration present");
  const mb = (fs.statSync(preview).size / 1e6).toFixed(1);
  ok(Number(mb) > 0.5, `file size ${mb}MB`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
