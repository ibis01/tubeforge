// BYOV (Bring-Your-Own-Voice) E2E — proves a user voice from the internet or an
// upload replaces TTS end-to-end: ingest → normalize → scene cut → final render.
//
//   1. TTS a realistic voice sample from the target video's own script
//   2. guardrails: invalid URL → 400, fileless upload → 400, non-audio URL → readable job error
//   3. upload mode: multipart WAV → voiceSource=custom, scene WAVs re-cut
//   4. url mode: real internet mp3 → downloaded, converted, re-cut (voiceLabel from URL)
//   5. render (kenburns) consumes the custom-cut audio → final.mp4 with an aac track
//
// Usage: node scripts/test-byov.mjs [videoId]
// Default target: the demo scene video "The 5 Morning Habits That Rewire Your Brain".

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import ZAI from "z-ai-web-dev-sdk";

const BASE = "http://localhost:3000";
const VID = process.argv[2] ?? "cmvmyynva000roxpufl6yx7jg";
const SAMPLE = "scripts/byov-sample-voice.wav";
const URL_VOICE = "https://download.samplelib.com/mp3/sample-15s.mp3";

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};

const api = async (p, opts = {}) => {
  const res = await fetch(`${BASE}${p}`, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
};

const ffprobeDuration = (file) => {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", file],
    { maxBuffer: 4 * 1024 * 1024 }
  ).toString();
  return Number(JSON.parse(out).format?.duration ?? 0);
};

const ffprobeStreams = (file) => {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", file],
    { maxBuffer: 4 * 1024 * 1024 }
  ).toString();
  return JSON.parse(out).streams ?? [];
};

const detail = async () => (await api(`/api/videos/${VID}`)).body.video;

/** Wait until the voiceover job leaves the running state (success or failure). */
const waitVoiceover = async (timeoutMs = 150_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = await api(`/api/videos/${VID}`);
    if (!d.body?.generating?.voiceover) return d.body.video;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("voiceover job timed out");
};

const waitRender = async (timeoutMs = 8 * 60_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = await api(`/api/videos/${VID}/render`);
    if (!d.body?.rendering) return d.body;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("render job timed out");
};

console.log(`\n=== BYOV E2E — video ${VID} ===\n`);

// ---------- 0. Preconditions ----------
console.log("0) Preconditions");
const v0 = await detail();
ok(v0, "detail fetch works");
ok(v0.format === "story", `video is scene format (${v0.sceneCount} scenes)`);
ok(v0.hasStoryboard, "storyboard painted (render can run)");
ok(v0.hasVoiceover, "video currently has a TTS voiceover");
ok(["tts", "custom"].includes(v0.voiceSource), `voiceSource starts sane (got "${v0.voiceSource}")`);
const scenesCount = v0.sceneCount;

// ---------- 1. Build a realistic voice sample via TTS ----------
console.log("\n1) TTS voice sample from the video's own script");
const speechSrc = (v0.script ?? "").replace(/\s+/g, " ").trim().slice(0, 650);
const cutTo = speechSrc.lastIndexOf(".");
const speech = cutTo > 200 ? speechSrc.slice(0, cutTo + 1) : speechSrc;
const zai = await ZAI.create();
const tts = await zai.audio.tts.create({
  input: speech,
  voice: "jam",
  speed: 1.0,
  response_format: "wav",
  stream: false,
});
fs.writeFileSync(SAMPLE, Buffer.from(new Uint8Array(await tts.arrayBuffer())));
const sampleDur = ffprobeDuration(SAMPLE);
ok(fs.statSync(SAMPLE).size > 10_000, `sample voice written (${sampleDur.toFixed(1)}s)`);

// ---------- 2. Guardrails ----------
console.log("\n2) Guardrails");
const badUrl = await api(`/api/videos/${VID}/voiceover`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mode: "url", url: "not a url" }),
});
ok(badUrl.status === 400, `invalid URL rejected (400, got ${badUrl.status})`);

// Bodyless POST is the documented TTS path (footer button uses it) — it must
// run the built-in voices AND flip voiceSource back to "tts".
const ttsPost = await api(`/api/videos/${VID}/voiceover`, { method: "POST" });
ok(ttsPost.status === 202, `bodyless POST starts the TTS path (202, got ${ttsPost.status})`);
const ttsVid = await waitVoiceover();
ok(ttsVid.voiceSource === "tts", "TTS path flips voiceSource back to tts");
ok(!ttsVid.error, `TTS regen clean (${ttsVid.error ?? "no error"})`);

const htmlUrl = await api(`/api/videos/${VID}/voiceover`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mode: "url", url: "https://example.com" }),
});
ok(htmlUrl.status === 202, "non-audio URL accepted for background validation");
const htmlVid = await waitVoiceover();
ok(
  Boolean(htmlVid.error) && /audio/i.test(htmlVid.error),
  `non-audio link fails with a readable error: "${(htmlVid.error ?? "").slice(0, 90)}"`
);

// ---------- 3. Upload mode ----------
console.log("\n3) Upload mode — my-studio-voice.wav");
const fd = new FormData();
fd.append(
  "file",
  new Blob([fs.readFileSync(SAMPLE)], { type: "audio/wav" }),
  "my-studio-voice.wav"
);
const up = await api(`/api/videos/${VID}/voiceover`, { method: "POST", body: fd });
ok(up.status === 202, `upload accepted (202, got ${up.status})`);
const upVid = await waitVoiceover();
ok(upVid.voiceSource === "custom", "voiceSource flipped to custom");
ok(upVid.voiceLabel === "my-studio-voice.wav", `voiceLabel="${upVid.voiceLabel}"`);
ok(!upVid.error, `no error after upload (${upVid.error ?? "clean"})`);
ok(upVid.hasVoiceover === true, "hasVoiceover true");
ok(
  Math.abs((upVid.audioDuration ?? 0) - sampleDur) < 2,
  `audioDuration ${upVid.audioDuration}s ≈ sample ${sampleDur.toFixed(1)}s`
);
const dir = path.join("uploads", VID);
ok(fs.existsSync(path.join(dir, "voiceover.wav")), "voiceover.wav on disk");
for (let i = 1; i <= scenesCount; i++) {
  const f = path.join(dir, `scene-${String(i).padStart(2, "0")}.wav`);
  ok(
    fs.existsSync(f) && fs.statSync(f).size > 44,
    `scene-${String(i).padStart(2, "0")}.wav re-cut (${fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1024) : 0} KB)`
  );
  if (i > 2) break; // spot-check first 3, keep output tight
}

// ---------- 4. URL mode (real internet file) ----------
console.log("\n4) URL mode — internet mp3");
const urlPost = await api(`/api/videos/${VID}/voiceover`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mode: "url", url: URL_VOICE }),
});
ok(urlPost.status === 202, `URL voice accepted (202, got ${urlPost.status})`);
const urlVid = await waitVoiceover(180_000);
ok(urlVid.voiceSource === "custom", "voiceSource stays custom");
ok(urlVid.voiceLabel === "sample-15s.mp3", `voiceLabel from URL="${urlVid.voiceLabel}"`);
ok(!urlVid.error, `no error after URL ingest (${urlVid.error ?? "clean"})`);
// VBR mp3 headers lie — trust the converted WAV on disk as the ground truth.
const urlWavDur = ffprobeDuration(path.join(dir, "voiceover.wav"));
ok(
  Math.abs((urlVid.audioDuration ?? 0) - urlWavDur) < 1 && urlWavDur > 13,
  `audioDuration ${urlVid.audioDuration}s ≈ converted WAV ${urlWavDur.toFixed(1)}s (mp3 decoded)`
);
ok(fs.existsSync(path.join(dir, "scene-01.wav")), "scene WAVs re-cut from the internet voice");
ok(urlVid.hasVideo === false, "stale render invalidated (hasVideo false)");

// ---------- 5. Render with the custom voice ----------
console.log("\n5) Render with the custom voice (kenburns)");
const renderPost = await api(`/api/videos/${VID}/render`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mode: "kenburns", subtitles: true, smartCaptions: false, music: false }),
});
ok(renderPost.status === 202, `render accepted (202, got ${renderPost.status})`);
const render = await waitRender();
ok(render.hasVideo === true, "hasVideo true after render");
ok(!render.error, `render clean (${render.error ?? "no error"})`);
const finalPath = path.join(dir, "final.mp4");
ok(fs.existsSync(finalPath), "final.mp4 on disk");
const finalDur = ffprobeDuration(finalPath);
ok(finalDur > 13, `final.mp4 duration ${finalDur.toFixed(1)}s (covers the ${urlWavDur.toFixed(1)}s voice)`);
const streams = ffprobeStreams(finalPath);
ok(streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac"), "final.mp4 carries the custom voice (aac audio track)");
const vFinal = await detail();
ok(vFinal.hasVideo === true && (vFinal.videoDuration ?? 0) > 13, "detail DTO reflects the rendered video");

// ---------- Summary ----------
console.log(`\n=== BYOV E2E: ${pass} passed, ${fail} failed ===`);
fs.rmSync(SAMPLE, { force: true });
process.exit(fail === 0 ? 0 : 1);
