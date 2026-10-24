// Story Engine E2E — scene script → identity-locked storyboard → per-scene
// voiceover → thumbnail → Ken Burns render → MP4 verification.
// Run: node scripts/test-story-e2e.mjs
import fs from "fs";

const BASE = "http://localhost:3000";
const t0 = Date.now();
const step = (msg) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${msg}`);

async function j(url, opts) {
  const res = await fetch(BASE + url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202)
    throw new Error(`${url} -> HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(url, predicate, label, intervalMs = 3000, capMs = 15 * 60 * 1000) {
  const deadline = Date.now() + capMs;
  for (;;) {
    const res = await fetch(BASE + url, { cache: "no-store" });
    const data = await res.json();
    if (predicate(data)) return data;
    if (data.error && data.error !== null && (data.video?.error || data.error))
      if (data.video?.error) throw new Error(`${label} failed: ${data.video.error}`);
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    await sleep(intervalMs);
  }
}

// Pick the demo character with a portrait (Professor Vex)
const chars = (await j("/api/characters")).data.characters;
const host = chars.find((c) => c.hasPortrait) ?? null;
console.log(`host: ${host ? `${host.name} (portrait ✓)` : "none"} | ${chars.length} characters`);

step("POST /api/videos (format=story, short → 4 scenes)");
const created = await j("/api/videos", {
  method: "POST",
  body: JSON.stringify({
    topic: "The medieval library that vanished without a trace",
    niche: "Mysteries",
    tone: "mysterious",
    length: "short",
    voice: host?.voice ?? "jam",
    format: "story",
    renderMode: "kenburns",
    characterId: host?.id ?? null,
  }),
});
const video = created.data.video;
console.log(
  `  title: "${video.title}" | ${video.sceneCount} scenes | ${video.wordCount} words | cast: ${video.characterName ?? "—"}`
);
if (video.sceneCount < 2) throw new Error("Expected at least 2 scenes");
const scenes = video.scenes;
console.log(
  `  scenes: ${scenes.map((s) => `#${s.index} ${s.title} [${s.camera}]${s.hostInScene ? " 👤" : ""}`).join(" | ")}`
);

step("POST storyboard (identity-locked if host)");
await j(`/api/videos/${video.id}/storyboard`, { method: "POST", body: "{}" });
await poll(
  `/api/videos/${video.id}`,
  (d) => d.video.hasStoryboard,
  "storyboard",
  4000,
  20 * 60 * 1000
);
const board = (await j(`/api/videos/${video.id}/storyboard`)).data;
const withImages = board.scenes.filter((s) => s.hasImage).length;
console.log(`  storyboard complete: ${withImages}/${board.scenes.length} scene images`);
if (withImages !== scenes.length) throw new Error("Storyboard incomplete");

step("POST voiceover (per-scene TTS)");
await j(`/api/videos/${video.id}/voiceover`, { method: "POST" });
await poll(
  `/api/videos/${video.id}`,
  (d) => d.video.hasVoiceover,
  "voiceover",
  4000,
  20 * 60 * 1000
);
const voiced = (await j(`/api/videos/${video.id}`)).data.video;
console.log(`  voiceover: ${Math.round(voiced.audioDuration)}s total audio (merged WAV)`);

step("POST thumbnail");
await j(`/api/videos/${video.id}/thumbnail`, { method: "POST" });
await poll(`/api/videos/${video.id}`, (d) => d.video.hasThumbnail, "thumbnail");
console.log("  thumbnail generated");

step("POST render (Ken Burns + subtitles + music)");
const renderPost = await j(`/api/videos/${video.id}/render`, {
  method: "POST",
  body: JSON.stringify({ mode: "kenburns", subtitles: true, music: true }),
});
console.log(`  render accepted: ${renderPost.status}`);
let lastLabel = "";
const renderDone = await poll(
  `/api/videos/${video.id}/render`,
  (d) => !d.rendering,
  "render",
  5000,
  20 * 60 * 1000
);
if (renderDone.error) throw new Error(`render failed: ${renderDone.error}`);
console.log(
  `  render complete: ${Math.round(renderDone.videoDuration)}s${renderDone.progress ? "" : ""}`
);

step("Verify final.mp4 via streaming + ffprobe");
const mp4Res = await fetch(BASE + `/api/videos/${video.id}/mp4`);
console.log(`  GET /mp4: ${mp4Res.status} ${mp4Res.headers.get("content-type")} ${mp4Res.headers.get("content-length")}B`);
if (mp4Res.status !== 200) throw new Error("MP4 GET failed");
const rangeRes = await fetch(BASE + `/api/videos/${video.id}/mp4`, {
  headers: { Range: "bytes=0-1023" },
});
console.log(`  Range request: ${rangeRes.status} ${rangeRes.headers.get("content-range")}`);
if (rangeRes.status !== 206) throw new Error("Range streaming broken");

// Export ZIP check
step("Verify export ZIP");
const zipRes = await fetch(BASE + `/api/videos/${video.id}/export`);
const zipBuf = Buffer.from(await zipRes.arrayBuffer());
fs.writeFileSync("/home/z/my-project/scripts/story-e2e.zip", zipBuf);
console.log(
  `  export ZIP: ${zipRes.status}, ${(zipBuf.length / 1024 / 1024).toFixed(1)}MB -> scripts/story-e2e.zip`
);

console.log("\n=== STORY E2E PASSED ===");
console.log(`video id: ${video.id}`);
process.exit(0);
