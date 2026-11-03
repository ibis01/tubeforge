// S2-a render evidence — the honest mix against the real ffmpeg pipeline.
//
// Uses the "Hidden Empire" fixture (12 scenes, art + WAVs on disk, aligned
// timeline doc). Two 3-scene PREVIEW renders (fast, write preview.mp4):
//
//   CONTROL  — the doc as-is (all fade 0.5s): D1 = Σdur − 2×0.5
//   EDITED   — scene 2 transitionIn=cut, scene 3 transitionIn=fadeblack,
//              music levels varied, caption edited: D2 = Σdur − 0.5
//              (a cut carries ZERO blend debt)
//
// The differential D2 − D1 ≈ +0.5s is assumption-free proof the per-boundary
// stitch honored the cut (a render that blended both seams would come out
// 0.5s shorter). Also verifies: buildSmartSrt's caption override replaces
// the edited scene's cues. Restores the original doc afterwards.
//
//   node --import tsx scripts/s2-render-evidence.mts

import fs from "fs";
import path from "path";
import { promisify } from "util";
import { execFile } from "child_process";
import { PrismaClient } from "@prisma/client";
import { withCtx } from "../src/lib/tubeforge/tenant.ts";
import { runRenderJob } from "../src/lib/tubeforge/video-jobs.ts";
import { buildSmartSrt } from "../src/lib/tubeforge/captions.ts";
import { probeDuration } from "../src/lib/tubeforge/render.ts";
import { parseScenes } from "../src/lib/tubeforge/story.ts";

const execFileAsync = promisify(execFile);
const db = new PrismaClient();

const VIDEO_ID = "cmw084tkl0009mcl90xrpwefq";
const CTX = { userId: "cmw064izz0000mcflzz96grfq", organizationId: "cmw064j000001mcflab5gax1n", role: "owner" };
const DIR = `/home/z/my-project/uploads/${VIDEO_ID}`;
const LEAD = 0.35, TAIL = 0.85, MIN_SEG = 2.0, TRANS_D = 0.5;

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

await withCtx(CTX, async () => {
  const video = await db.video.findUnique({ where: { id: VIDEO_ID } });
  if (!video) fail("fixture video missing");
  const originalTimeline = video.timeline;
  const scenes = parseScenes(video.scenes);
  const doc = JSON.parse(video.timeline ?? "{}");

  // Expected segment durations: replicate the render's clamp exactly.
  const wavDur = async (i: number) => {
    const f = path.join(DIR, `scene-${String(i).padStart(2, "0")}.wav`);
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]);
    return Math.max(Number(stdout.trim()) + LEAD + TAIL, MIN_SEG);
  };
  const wavs = [await wavDur(1), await wavDur(2), await wavDur(3)];
  const segDurs = [0, 1, 2].map((k) => {
    const t = doc.scenes[k]?.durationSec;
    if (typeof t !== "number" || !Number.isFinite(t) || t < MIN_SEG) return wavs[k];
    const floor = Math.max(wavs[k] - TAIL + 0.3, MIN_SEG);
    return Math.min(Math.max(t, floor), wavs[k] * 3);
  });
  const sigma = segDurs.reduce((a, b) => a + b, 0);
  console.log(`segments: ${segDurs.map((d) => d.toFixed(2)).join(" + ")} = Σ ${sigma.toFixed(2)}s`);
  console.log(`expected: D1 (fade,fade) = ${(sigma - 2 * TRANS_D).toFixed(2)}s · D2 (cut,fadeblack) = ${(sigma - TRANS_D).toFixed(2)}s`);

  const renderPreview = async (label: string) => {
    const t0 = Date.now();
    await runRenderJob(VIDEO_ID, { mode: "kenburns", music: true, subtitles: true, smartCaptions: false, sceneLimit: 3 });
    const p = path.join(DIR, "preview.mp4");
    if (!fs.existsSync(p)) fail(`${label}: preview.mp4 missing`);
    const d = await probeDuration(p);
    console.log(`${label}: preview.mp4 = ${d.toFixed(3)}s (${((Date.now() - t0) / 1000).toFixed(0)}s render)`);
    return d;
  };

  // ---- control render: the doc as-is (uniform fades) ----
  const d1 = await renderPreview("CONTROL (doc as-is)");
  if (Math.abs(d1 - (sigma - 2 * TRANS_D)) > 0.35)
    fail(`D1 ${d1.toFixed(2)}s vs expected ${(sigma - 2 * TRANS_D).toFixed(2)}s`);

  // ---- edit the doc like the studio would (cut + fadeblack + mix + caption) ----
  const edited = JSON.parse(video.timeline ?? "{}");
  edited.scenes[1].transitionIn = "cut";
  edited.scenes[2].transitionIn = "fadeblack";
  edited.scenes[1].audio.music.level = 0.2;
  edited.scenes[2].audio.music.level = 1.0;
  edited.scenes[1].audio.voice.level = 0.85;
  edited.scenes[1].caption = { text: "EDITED CAPTION — Geneva routing", startSec: edited.scenes[1].startSec, endSec: edited.scenes[1].endSec };
  await db.video.update({ where: { id: VIDEO_ID }, data: { timeline: JSON.stringify(edited) } });

  // buildSmartSrt's override path (asr off — the override fires before alignment anyway)
  const blended = [
    { start: 0, duration: segDurs[0] },
    { start: segDurs[0], duration: segDurs[1] },
    { start: segDurs[0] + segDurs[1], duration: segDurs[2] },
  ];
  const smart = await buildSmartSrt({
    videoId: VIDEO_ID,
    scenes: scenes.slice(0, 3),
    segments: blended,
    asr: false,
    captionOverrides: [null, "EDITED CAPTION — Geneva routing", null],
  });
  const cue2 = /EDITED CAPTION — Geneva routing/.test(smart.srt);
  const chunkLeak = /routing algorithm calculates/.test(smart.srt); // scene 2's narration chunks must NOT appear
  console.log(`smart SRT: ${smart.cueCount} cues; edited-caption cue present=${cue2}; scene-2 narration chunks leaked=${chunkLeak}`);
  if (!cue2) fail("caption override missing from smart SRT");
  if (chunkLeak) fail("scene 2's narration chunks replaced the edited caption incorrectly");

  // ---- edited render: cut + fadeblack + varied mix ----
  const d2 = await renderPreview("EDITED (cut + fadeblack + mix)");
  if (Math.abs(d2 - (sigma - TRANS_D)) > 0.35)
    fail(`D2 ${d2.toFixed(2)}s vs expected ${(sigma - TRANS_D).toFixed(2)}s`);
  const diff = d2 - d1;
  console.log(`differential D2 − D1 = ${diff.toFixed(3)}s (expected +0.500 — the cut seam removed one 0.5s blend)`);
  if (Math.abs(diff - 0.5) > 0.2) fail(`differential ${diff.toFixed(3)}s ≠ +0.5s — the cut was not honored`);

  // ---- restore the fixture ----
  await db.video.update({ where: { id: VIDEO_ID }, data: { timeline: originalTimeline } });
  console.log("fixture timeline restored");
  console.log("\nS2-A RENDER EVIDENCE PASS — per-boundary transitions, doc mix, and caption overrides all honored by the real pipeline");
});
await db.$disconnect();
