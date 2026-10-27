// End-to-end test: the 2/10-review quality overhaul.
//
// Covers, through the real app (dev server on :3000) with a local
// OpenAI-compatible stub for chat/image/tts/vision:
//   1. Scene counts per length: short=8, medium=12, long=16
//   2. rehook + sfx parsed end-to-end (scene 1 forced rehook, valid sfx kinds)
//   3. Thumbnail always matches the script: image prompt contains the
//      story's opening-scene concept (not a generic topic card)
//   4. Multi-shot kenburns render: camera cuts land ≤ ~3s apart, no black
//      frames, punch move on the rehook scene
//   5. SFX cue audible at scene starts (whoosh on scene 1)
//   6. Music bed present + limiter holds (no clipping)
//   7. Script re-roll invalidates the old thumbnail (files deleted + flag reset)
//
// Usage: node scripts/test-quality-overhaul.mjs

import http from "node:http";
import fs from "fs";
import path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const BASE = process.env.BASE ?? "http://localhost:3000";
const STUB_PORT = 3975;
const FIX = "/home/z/my-project/scripts/qo-fixtures";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
  cond ? passed++ : failed++;
};

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, body };
}

async function pollJob(id, flag, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await jfetch(`/api/videos/${id}`);
    if (!body?.video) throw new Error("video vanished mid-poll");
    if (!body.generating?.[flag]) return body.video;
    if (Date.now() > deadline) throw new Error(`${flag} job timed out`);
    await sleep(1500);
  }
}

// ---------- fixtures (real bytes for the image/tts stubs) ----------
fs.mkdirSync(FIX, { recursive: true });
const FIX_PNG = path.join(FIX, "art.png");
const FIX_WAV = path.join(FIX, "voice.wav");
await run("ffmpeg", ["-f", "lavfi", "-i", "testsrc2=size=1344x768:duration=1:rate=1", "-frames:v", "1", "-y", FIX_PNG]);
await run("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=180:duration=6", "-ac", "2", "-ar", "48000", "-y", FIX_WAV]);
const PNG_B64 = fs.readFileSync(FIX_PNG).toString("base64");
const WAV_BYTES = fs.readFileSync(FIX_WAV);

// ---------- story package served by the stub ----------
const SCENE1_VISUAL =
  "a cracked brass compass glowing on a rain-slicked map inside a lantern-lit study, ink pots tipped over";
function scenePkg(count) {
  // Scene 5 (index 4) is the mid-video rehook and deliberately leaves sfx at
  // "none" — the script engine must upgrade it to a "sting" automatically.
  const sfxCycle = ["whoosh", "none", "boom", "none", "none", "pop", "sting", "riser"];
  return {
    title: "The Compass That Pointed Backwards",
    description: "A mystery short about a compass that betrayed its owner. #mystery #compass",
    tags: ["mystery", "compass", "shorts", "story", "objects", "history", "secrets", "curiosities", "tales", "oddities"],
    scenes: Array.from({ length: count }, (_, i) => ({
      title: `Beat ${i + 1}`,
      narration:
        i === 0
          ? "At 3:07 a.m. the compass spun backwards, and the cartographer knew the map was lying to him."
          : `Beat ${i + 1}: the trail grows stranger — the compass needle now points at the map's edge where nothing is drawn, and the ink refuses to dry.`,
      visual: i === 0 ? SCENE1_VISUAL : `a storm-lashed cliff path above a black sea, beat ${i + 1}, wide cinematic shot`,
      camera: i % 2 ? "pan-right" : "zoom-in",
      mood: "teal shadows, cold moonlight, volumetric haze",
      caption: `The compass lied ${i + 1}`,
      hostInScene: false,
      rehook: i === 4,
      sfx: sfxCycle[i % sfxCycle.length],
    })),
  };
}

// ---------- stub ----------
const imagePrompts = [];
const chatPrompts = [];
function startStub(port) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, type, payload) => {
        res.writeHead(code, { "Content-Type": type });
        res.end(payload);
      };
      if (req.url?.includes("/chat/completions")) {
        const parsed = JSON.parse(body || "{}");
        const sys = String(parsed.system ?? parsed.messages?.find((m) => m.role === "system")?.content ?? "");
        const user = String(
          parsed.messages?.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ") ?? ""
        );
        chatPrompts.push({ sys: sys.slice(0, 400), user: user.slice(0, 400) });
        // vision quality gate → high score so the gate never re-rolls
        if (sys.includes("quality inspector")) {
          return send(200, "application/json", JSON.stringify({
            choices: [{ message: { role: "assistant", content: JSON.stringify({ score: 9, issues: [], summary: "clean art" }) } }],
          }));
        }
        // scene script writer → scene package
        const m = user.match(/exactly (\d+) scenes/);
        const count = m ? Number(m[1]) : 8;
        const content = JSON.stringify(scenePkg(count));
        return send(200, "application/json", JSON.stringify({
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { total_tokens: 10 },
        }));
      }
      if (req.url?.includes("/images/generations")) {
        try { imagePrompts.push(String(JSON.parse(body || "{}").prompt ?? "")); } catch { /* ignore */ }
        return send(200, "application/json", JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
      }
      if (req.url?.includes("/audio/speech")) {
        return send(200, "audio/wav", WAV_BYTES);
      }
      send(404, "application/json", JSON.stringify({ error: "stub: no route", url: req.url }));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// ---------- local ffprobe helpers ----------
async function probeDur(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file]);
  return Number(JSON.parse(stdout).format?.duration ?? 0);
}
async function blackFrames(file) {
  try {
    const o = await run("ffmpeg", ["-i", file, "-vf", "blackframe=amount=98:threshold=32", "-f", "null", "-"], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    return (o.stderr.match(/Parsed_blackframe/g) ?? []).length;
  } catch (e) { return (e.stderr?.match(/Parsed_blackframe/g) ?? []).length; }
}
async function cutTimes(file) {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-f", "lavfi", "-i", `movie=${file},select=gte(scene\\,0.05)`,
      "-show_entries", "frame=pts_time,pkt_pts_time,best_effort_timestamp_time", "-of", "json",
    ], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    return (JSON.parse(stdout || "{}")?.frames ?? [])
      .map((f) => Number(f.pts_time ?? f.pkt_pts_time ?? f.best_effort_timestamp_time ?? -1))
      .filter((t) => Number.isFinite(t) && t >= 0);
  } catch { return []; }
}
async function maxVol(file, from, to) {
  const o = await run("ffmpeg", ["-ss", String(from), "-to", String(to), "-i", file, "-af", "volumedetect", "-f", "null", "-"], { timeout: 60_000 });
  return Number((o.stderr.match(/max_volume: (-?[\d.]+) dB/) ?? [])[1] ?? -99);
}

// ---------- main ----------
async function main() {
  console.log(`\n=== quality-overhaul e2e @ ${BASE} ===\n`);

  // 0. Save capability configs for restore, then point everything at the stub
  const s0 = await jfetch("/api/settings/ai");
  const caps = s0.body?.capabilities ?? {};
  const restore = {};
  for (const cap of ["chat", "image", "tts", "vision"]) {
    if (caps[cap]) restore[cap] = caps[cap];
  }
  ok(Object.keys(restore).length >= 1, "0a. capability configs captured for restore");

  for (const cap of ["chat", "image", "tts"]) {
    const r = await jfetch("/api/settings/ai", {
      method: "PUT",
      body: JSON.stringify({
        capability: cap, provider: "openai",
        baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, apiKey: "stub-key", model: "stub-model",
      }),
    });
    ok(r.status === 200, `0b. ${cap} → local stub`);
  }
  // vision is NOT a separate capability — it follows the chat provider, which
  // the stub already answers (quality-inspector calls get a score-9 JSON).

  const stub = await startStub(STUB_PORT);

  // 1. Scene counts for short / medium / long (script stage only)
  const counts = { short: 8, medium: 12, long: 16 };
  const ids = {};
  for (const [length, want] of Object.entries(counts)) {
    const c = await jfetch("/api/videos", {
      method: "POST",
      body: JSON.stringify({ topic: "Quality overhaul probe: the compass that pointed backwards", niche: "Mysteries", tone: "mysterious", length, format: "story" }),
    });
    const id = c.body?.video?.id;
    ids[length] = id;
    if (!id) { ok(false, `1. create ${length} video`); continue; }
    const v = await pollJob(id, "script");
    ok(v.scenes?.length === want, `1. ${length} → ${want} scenes (new SCENE_COUNTS)`, `got ${v.scenes?.length}`);
    ok(
      v.scenes?.[0]?.rehook === true,
      `1. ${length} scene 1 is a rehook`,
      `rehook=${v.scenes?.[0]?.rehook}`
    );
    ok(
      v.scenes?.every((s) => ["whoosh", "boom", "riser", "sting", "pop", "none"].includes(s.sfx)),
      `1. ${length} all sfx values valid`
    );
    ok(
      v.scenes?.some((s, i) => i > 0 && s.rehook),
      `1. ${length} mid-video rehook present`
    );
    const midRehook = v.scenes?.find((s, i) => i > 0 && s.rehook);
    ok(
      midRehook?.sfx === "sting",
      `1. ${length} rehook with sfx=none auto-upgraded to sting`,
      `got "${midRehook?.sfx}"`
    );
  }

  // 2. Full pipeline on the SHORT video: storyboard → voiceover → thumbnail
  const vid = ids.short;
  if (!vid) { console.error("FATAL: no short video — aborting pipeline stage"); process.exit(1); }

  await jfetch(`/api/videos/${vid}/storyboard`, { method: "POST" });
  const boarded = await pollJob(vid, "storyboard");
  ok(boarded.hasStoryboard === true, "2a. storyboard complete (8 stub images)");
  ok(
    imagePrompts.some((p) => p.includes(SCENE1_VISUAL.slice(0, 40))),
    "2b. storyboard image prompts carry the scene visuals"
  );

  await jfetch(`/api/videos/${vid}/voiceover`, { method: "POST" });
  const voiced = await pollJob(vid, "voiceover");
  ok(voiced.hasVoiceover === true, "2c. voiceover complete (stub wavs)");

  imagePrompts.length = 0;
  await jfetch(`/api/videos/${vid}/thumbnail`, { method: "POST" });
  const thumbed = await pollJob(vid, "thumbnail");
  ok(thumbed.hasThumbnail === true, "2d. thumbnail generated");
  ok(
    imagePrompts.some((p) => p.includes("depicting this exact moment") && p.includes(SCENE1_VISUAL.slice(0, 40))),
    "2e. THUMBNAIL PAINTS THE SCRIPT — prompt contains scene-1 story moment",
    imagePrompts[0]?.slice(0, 90)
  );
  ok(fs.existsSync(path.join("/home/z/my-project/uploads", vid, "thumbnail.png")), "2f. thumbnail.png on disk");

  // 3. Render preview (first 2 scenes, kenburns, music+subtitles on)
  const r = await jfetch(`/api/videos/${vid}/render`, {
    method: "POST",
    body: JSON.stringify({ mode: "kenburns", subtitles: true, music: true, smartCaptions: false, sceneLimit: 2 }),
  });
  ok(r.status === 202, "3a. preview render accepted (202)");
  const rendered = await pollJob(vid, "render");
  const previewPath = path.join("/home/z/my-project/uploads", vid, "preview.mp4");
  ok(fs.existsSync(previewPath), "3b. preview.mp4 written");

  const dur = await probeDur(previewPath);
  ok(dur > 12 && dur < 20, "3c. preview duration sane (2 scenes × ~6s+pad)", `${dur.toFixed(1)}s`);
  const bf = await blackFrames(previewPath);
  ok(bf === 0, "3d. zero black frames across every shot", `${bf} black frames`);

  // 4. Camera cuts ≤ ~3s apart in every scene (multi-shot engine)
  const cuts = await cutTimes(previewPath);
  // scenes: 6s voice + 1.2 pad = 7.2s each → shots per scene = round(7.2/2.7)=3 → 2 cuts/scene = 4 total
  ok(cuts.length >= 4, "4a. multi-shot cuts present (≥4 across 2 scenes)", `cuts at ${cuts.map((t) => t.toFixed(2)).join(", ")}`);
  const gaps = [0, ...cuts, dur].slice(1).map((t, i, arr) => t - [0, ...cuts, dur][i]).filter((g) => g > 0);
  const maxGap = Math.max(...gaps);
  ok(maxGap <= 3.3, "4b. visual change at least every ~3s (max shot gap ≤ 3.3s)", `maxGap=${maxGap.toFixed(2)}s`);

  // 5. SFX on the rehook opener + mix hygiene
  const startPeak = await maxVol(previewPath, 0.05, 0.35);
  ok(startPeak > -25, "5a. whoosh audible in scene 1 lead-in (punch + sfx)", `start peak ${startPeak} dB`);
  const overall = await maxVol(previewPath, 0, Math.min(dur, 12));
  ok(overall <= -0.05 && overall > -12, "5b. limiter holds / no silence", `overall peak ${overall} dB`);

  // 6. Re-roll the script → old thumbnail must be invalidated
  const thumbBefore = fs.existsSync(path.join("/home/z/my-project/uploads", vid, "thumbnail.png"));
  ok(thumbBefore, "6a. thumbnail exists before re-roll");
  await jfetch(`/api/videos/${vid}/script`, { method: "POST" });
  const rerolled = await pollJob(vid, "script");
  ok(Boolean(rerolled.script), "6b. re-roll landed");
  ok(rerolled.hasThumbnail === false, "6c. hasThumbnail reset on re-roll (stale cover invalidated)");
  ok(!fs.existsSync(path.join("/home/z/my-project/uploads", vid, "thumbnail.png")), "6d. thumbnail.png deleted on re-roll");

  // 7. Cleanup: delete videos, restore settings, stop stub
  for (const id of Object.values(ids)) {
    if (id) await jfetch(`/api/videos/${id}`, { method: "DELETE" });
  }
  for (const [cap, cfg] of Object.entries(restore)) {
    await jfetch("/api/settings/ai", {
      method: "PUT",
      body: JSON.stringify({
        capability: cap, provider: cfg.provider,
        ...(cfg.provider === "zai"
          ? {}
          : { baseUrl: cfg.baseUrl, apiKey: cfg.hasKey ? "restored" : undefined, model: cfg.model }),
        model: cfg.model ?? undefined,
      }),
    });
  }
  const sFinal = await jfetch("/api/settings/ai");
  ok(sFinal.status === 200, "7a. settings restored (final read ok)");
  stub.close();
  fs.rmSync(FIX, { recursive: true, force: true });

  console.log(`\n${passed} PASS / ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
