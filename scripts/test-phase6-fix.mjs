// E2E — "it still doesn't generate videos" fix validation:
//   1. Convert a classic narration video to scene format (GLM split + silence-cut voiceover)
//   2. Paint the storyboard
//   3. Render an ANIMATED preview (CogVideoX i2v) — the thing the user says is missing
import fs from "fs";
import path from "path";

const BASE = "http://localhost:3000";
const VIDEO_ID = process.argv[2] ?? "cmvmyynva000roxpufl6yx7jg";
const UPLOADS = "/home/z/my-project/uploads";

let pass = 0, fail = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts) {
  const res = await fetch(`${BASE}${p}`, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function pollVideo(id, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api(`/api/videos/${id}`);
    if (predicate(body)) return body;
    if (body.video?.error) throw new Error(`server error: ${body.video.error}`);
    process.stdout.write(`    ...${label} (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)\r`);
    await sleep(4000);
  }
  throw new Error(`timeout: ${label}`);
}

async function probe(file) {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const out = JSON.parse((await promisify(execFile)("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_name,width,height", "-of", "json", file])).stdout);
  return { duration: Number(out.format?.duration ?? 0), streams: out.streams ?? [] };
}

console.log(`\n=== TubeForge fix E2E — video ${VIDEO_ID} ===\n`);

// ---- 0) baseline ----
const v0 = await api(`/api/videos/${VIDEO_ID}`);
ok(v0.status === 200, "video exists");
const wasClassic = v0.body.video?.format === "script";
console.log(`  format: ${v0.body.video?.format}, voiced: ${v0.body.video?.hasVoiceover}\n`);

// ---- 1) convert ----
if (wasClassic) {
  console.log("[1] POST /convert (classic → scene)");
  const c = await api(`/api/videos/${VIDEO_ID}/convert`, { method: "POST" });
  ok(c.status === 202 || c.status === 200, `convert accepted (${c.status}) ${JSON.stringify(c.body).slice(0, 100)}`);

  const conv = await pollVideo(VIDEO_ID, (b) => b.video?.format === "story", 5 * 60_000, "converting");
  const scenes = conv.video?.scenes ?? [];
  ok(conv.video?.format === "story", "format flipped to story");
  ok(scenes.length >= 2, `${scenes.length} scenes created`);
  ok(scenes.every((s) => s.narration && s.visual), "every scene has narration + visual prompt");
  ok(conv.video?.hasVoiceover === true, "voiceover preserved (hasVoiceover true)");
  ok(!conv.video?.hasStoryboard && !conv.video?.hasVideo, "storyboard/video flags reset");

  // script words must survive the split
  const scriptWords = (conv.video.script.toLowerCase().match(/[a-z0-9']+/g) ?? []).length;
  const sceneWords = scenes.map((s) => s.narration.toLowerCase().match(/[a-z0-9']+/g) ?? []).flat().length;
  ok(sceneWords >= scriptWords * 0.6, `narration coverage ${sceneWords}/${scriptWords} words (${Math.round((sceneWords / scriptWords) * 100)}%)`);

  // per-scene WAVs cut from the original voiceover
  const dir = path.join(UPLOADS, VIDEO_ID);
  const wavDur = [];
  let allWavs = true;
  for (const s of scenes) {
    const f = path.join(dir, `scene-${String(s.index).padStart(2, "0")}.wav`);
    if (!fs.existsSync(f)) { allWavs = false; break; }
    wavDur.push((await probe(f)).duration);
  }
  ok(allWavs, `all ${scenes.length} scene WAVs cut`);
  const voDur = (await probe(path.join(dir, "voiceover.wav"))).duration;
  const sum = wavDur.reduce((a, b) => a + b, 0);
  ok(Math.abs(sum - voDur) / voDur < 0.15, `scene audio ${sum.toFixed(1)}s ≈ voiceover ${voDur.toFixed(1)}s (drift ${(100 * Math.abs(sum - voDur) / voDur).toFixed(1)}%)`);
  console.log(`    scene durations: ${wavDur.map((d) => d.toFixed(1)).join(", ")}s`);

  // double-convert must 400
  const again = await api(`/api/videos/${VIDEO_ID}/convert`, { method: "POST" });
  ok(again.status === 400, "re-convert correctly rejected 400");
} else {
  console.log("[1] video already story — skipping convert");
}

// ---- 2) storyboard ----
console.log("\n[2] POST /storyboard");
const sb = await api(`/api/videos/${VIDEO_ID}/storyboard`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
ok(sb.status === 202 || sb.status === 200, `storyboard accepted (${sb.status})`);
await pollVideo(VIDEO_ID, (b) => b.video?.hasStoryboard === true, 15 * 60_000, "painting scenes");
ok(true, "storyboard complete");

// ---- 3) ANIMATED render (preview = scene 1) ----
console.log("\n[3] POST /render {mode: animated, sceneLimit: 1} — CogVideoX i2v");
const r = await api(`/api/videos/${VIDEO_ID}/render`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mode: "animated", sceneLimit: 1, subtitles: true, music: true }),
});
ok(r.status === 202, `render accepted 202 (${JSON.stringify(r.body).slice(0, 90)})`);

const t0 = Date.now();
let lastLabel = "";
const rend = await (async () => {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const { body } = await api(`/api/videos/${VIDEO_ID}/render`);
    if (body.progress?.label && body.progress.label !== lastLabel) {
      lastLabel = body.progress.label;
      console.log(`    [${Math.round((Date.now() - t0) / 1000)}s] ${lastLabel} (${body.progress.current}/${body.progress.total})`);
    }
    if (!body.rendering) return body;
    await sleep(5000);
  }
  throw new Error("render timeout");
})();
ok(!rend.error, `render finished without error in ${Math.round((Date.now() - t0) / 1000)}s`);

const preview = path.join(UPLOADS, VIDEO_ID, "preview.mp4");
ok(fs.existsSync(preview), "preview.mp4 exists (animated)");
if (fs.existsSync(preview)) {
  const info = await probe(preview);
  const v = info.streams.find((s) => s.codec_name === "h264");
  ok(v && info.duration > 2, `h264 ${v?.width}x${v?.height}, ${info.duration.toFixed(1)}s`);
  ok(info.streams.some((s) => s.codec_name === "aac"), "narration audio present (aac)");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
