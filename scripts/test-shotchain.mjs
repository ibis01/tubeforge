// Standalone ffmpeg validation for the render.ts quality overhaul:
//   1. multi-shot Ken Burns graph (replicates multiShotFilter exactly)
//   2. no black frames anywhere (blackframe count == 0)
//   3. visible hard cuts ≈ shotCount-1 (scene-change detector, cut-aware threshold)
//   4. SFX cue mixes into the scene start (peak rise vs voice-only)
//   5. music ducking: bed level during speech < bed level in silence
// Replication (not import) is acceptable because the app-level E2E in
// test-quality-overhaul.mjs exercises the real code path end to end.

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const run = promisify(execFile);
const TMP = "/home/z/my-project/scripts/shotchain-tmp";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const FPS = 30;
const SHOT_SEC = 2.7;
const MAX_SHOTS = 12;
const GRADE = "eq=contrast=1.05:saturation=1.08,vignette=PI/5";

const ffmpeg = async (args, label) => {
  try {
    await run("ffmpeg", args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    console.log(`  ok: ${label}`);
  } catch (err) {
    const e = err;
    console.error(`  FAIL ${label}:\n${(e.stderr ?? "").split("\n").slice(-8).join("\n")}`);
    process.exit(1);
  }
};

const probe = async (file) => {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "json", file,
  ]);
  return Number(JSON.parse(stdout).format?.duration ?? 0);
};

// ---- verbatim copies of render.ts pure functions ----
function kenBurnsFilter(variant, totalFrames, zStart) {
  const last = Math.max(totalFrames - 1, 1);
  const centeredX = "iw/2-(iw/zoom)/2";
  const centeredY = "ih/2-(ih/zoom)/2";
  const panX = (fwd) =>
    fwd ? "(iw-iw/zoom)*(0.15+0.7*on/" + last + ")" : "(iw-iw/zoom)*(0.85-0.7*on/" + last + ")";
  const panY = (fwd) =>
    fwd ? "(ih-ih/zoom)*(0.15+0.7*on/" + last + ")" : "(ih-ih/zoom)*(0.85-0.7*on/" + last + ")";
  switch (variant) {
    case "zoom-out": return `z='1.12-0.12*on/${last}':x='${centeredX}':y='${centeredY}'`;
    case "pan-right": return `z='${zStart.toFixed(2)}':x='${panX(true)}':y='${centeredY}'`;
    case "pan-left": return `z='${zStart.toFixed(2)}':x='${panX(false)}':y='${centeredY}'`;
    case "tilt-down": return `z='${zStart.toFixed(2)}':x='${centeredX}':y='${panY(true)}'`;
    case "tilt-up": return `z='${zStart.toFixed(2)}':x='${centeredX}':y='${panY(false)}'`;
    case "push-in": return `z='1.02+0.17*on/${last}':x='${centeredX}':y='${centeredY}'`;
    case "punch": {
      const f = Math.max(Math.round(0.45 * FPS), 2);
      return `z='if(lte(on\\,${f})\\,1.16-0.10*on/${f}\\,1.06+0.05*(on-${f})/${Math.max(last - f, 1)})':x='${centeredX}':y='${centeredY}'`;
    }
    default: return `z='1+0.12*on/${last}':x='${centeredX}':y='${centeredY}'`;
  }
}

function endZoomOf(variant, zStart) {
  switch (variant) {
    case "zoom-in": return 1.12;
    case "zoom-out": return 1.0;
    case "push-in": return 1.19;
    case "punch": return 1.11;
    default: return zStart;
  }
}

function shotSequence(camera, shotCount, rehook) {
  const rotation = ["zoom-in", "pan-right", "zoom-out", "tilt-down", "push-in", "pan-left", "zoom-out", "tilt-up"];
  const first = rehook && camera !== "punch" ? "punch" : camera;
  const isPanOrTilt = ["pan-right", "pan-left", "tilt-down", "tilt-up"].includes(first);
  const shots = [{ id: first, zStart: isPanOrTilt ? 1.1 : 1.0 }];
  let i = 0;
  while (shots.length < shotCount) {
    const next = rotation[i++ % rotation.length];
    if (next === shots[shots.length - 1].id) continue;
    const prevEnd = endZoomOf(shots[shots.length - 1].id, shots[shots.length - 1].zStart);
    shots.push({ id: next, zStart: prevEnd > 1.07 ? 1.04 : 1.14 });
  }
  return shots;
}

function multiShotFilter(dur, camera, rehook) {
  const totalFrames = Math.max(Math.round(dur * FPS), 2);
  const shotCount = Math.max(1, Math.min(MAX_SHOTS, Math.round(dur / SHOT_SEC)));
  const variants = shotSequence(camera, shotCount, rehook);
  const per = Math.max(Math.floor(totalFrames / shotCount), 2);
  const bounds = [];
  for (let i = 1; i < shotCount; i++) bounds.push(Math.min(per * i, totalFrames - 1));
  const parts = [
    `[0:v]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,split=${shotCount}${variants.map((_, i) => `[s${i}]`).join("")}`,
  ];
  let start = 0;
  variants.forEach(({ id, zStart }, i) => {
    const end = i < variants.length - 1 ? bounds[i] : totalFrames;
    const frames = Math.max(end - start, 2);
    const kb = kenBurnsFilter(id, frames, zStart);
    parts.push(`[s${i}]trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS,zoompan=${kb}:d=1:s=1920x1080:fps=${FPS},format=yuv420p[v${i}]`);
    start = end;
  });
  parts.push(`${variants.map((_, i) => `[v${i}]`).join("")}concat=n=${shotCount}:v=1:a=0[vc]`, `[vc]${GRADE}[v]`);
  return { graph: parts.join(";"), shotCount, variants };
}

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name} ${detail}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// ---------- fixtures ----------
console.log("fixtures");
const IMG = path.join(TMP, "scene.png");
const VOICE = path.join(TMP, "voice.wav"); // 8s speech-ish signal (noise bursts)
await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1344x768:duration=1:rate=1", "-frames:v", "1", "-y", IMG], "test image");
await ffmpeg(["-f", "lavfi", "-i", "anoisesrc=color=white:r=48000:amplitude=0.5:duration=8", "-af", "highpass=f=150,lowpass=f=6000", "-ac", "2", "-ar", "48000", "-y", VOICE], "voice wav");

// ---------- 1) multi-shot render (9.2s scene, rehook, whoosh) ----------
console.log("multi-shot kenburns render (9.2s, rehook, sfx=whoosh)");
const DUR = 8 + 0.35 + 0.85; // voice 8s + lead + tail = 9.2s
const { graph, shotCount, variants } = multiShotFilter(DUR, "zoom-in", true);
console.log(`  shots=${shotCount} [${variants.map(v => `${v.id}@${v.zStart}`).join(", ")}]`);
check("shot count = round(9.2/2.7)=3", shotCount === 3, `(got ${shotCount})`);
check("rehook opens with punch", variants[0].id === "punch");
check("no consecutive repeats", variants.every((v, i) => i === 0 || v.id !== variants[i - 1].id));

const WHOOSH = path.join(TMP, "whoosh.wav");
await ffmpeg(["-filter_complex", "anoisesrc=color=pink:r=48000:amplitude=0.85:duration=0.8,lowpass=f=2600,flanger=delay=6:depth=5:regen=35:speed=9:width=50:shape=sinusoidal,afade=t=in:d=0.26,afade=t=out:st=0.32:d=0.48,volume=1.9", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-y", WHOOSH], "whoosh synth");

const SEG = path.join(TMP, "seg.mp4");
await ffmpeg([
  "-loop", "1", "-framerate", String(FPS), "-t", DUR.toFixed(3), "-i", IMG,
  "-i", VOICE,
  "-i", WHOOSH,
  "-filter_complex",
  `${graph};[1:a]adelay=350:all=1,apad[voice];[2:a]adelay=40:all=1[sfx];[voice][sfx]amix=inputs=2:duration=first:normalize=0:weights='1 0.55'[a]`,
  "-map", "[v]", "-map", "[a]",
  "-t", DUR.toFixed(3), "-r", String(FPS),
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
  "-y", SEG,
], "scene segment");

const segDur = await probe(SEG);
check("segment duration exact", Math.abs(segDur - DUR) < 0.1, `(${segDur.toFixed(2)}s vs ${DUR.toFixed(2)}s)`);

// blackframe scan
const bf = await run("ffmpeg", ["-i", SEG, "-vf", "blackframe=amount=98:threshold=32", "-f", "null", "-"], { timeout: 60_000 }).catch((e) => e);
const bfOut = `${bf.stdout ?? ""}${bf.stderr ?? ""}`;
const blackCount = (bfOut.match(/Parsed_blackframe/g) ?? []).length;
check("zero black frames", blackCount === 0, `(detected ${blackCount})`);

// hard-cut detection at the boundary window (±0.2s around each expected cut)
// hard-cut detection: selected frame timestamps (scene > 0.05) printed via
// -show_entries (metadata=print goes to stderr, not stdout — do not parse it)
const sc = await run("ffprobe", [
  "-v", "error", "-f", "lavfi",
  "-i", `movie=${SEG},select=gte(scene\\,0.05)`,
  "-show_entries", "frame=pts_time,pkt_pts_time,best_effort_timestamp_time",
  "-of", "json",
], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }).catch((e) => e);
const cutTimes = (JSON.parse(sc.stdout || "{}")?.frames ?? [])
  .map((f) => Number(f.pts_time ?? f.pkt_pts_time ?? f.best_effort_timestamp_time ?? -1))
  .filter((t) => Number.isFinite(t) && t >= 0);
// expected boundaries land at floor-division shot intervals
const totalFrames = Math.round(DUR * FPS);
const framesPer = Math.floor(totalFrames / shotCount);
const expectedBoundaries = Array.from({ length: shotCount - 1 }, (_, k) => ((k + 1) * framesPer) / FPS);
const hits = expectedBoundaries.filter((b) =>
  cutTimes.some((t) => Math.abs(t - b) < 0.25)
).length;
const strays = cutTimes.filter((t) =>
  !expectedBoundaries.some((b) => Math.abs(t - b) < 0.25)
).length;
check(
  "hard cuts detected at every framing jump",
  hits === shotCount - 1,
  `(cuts at ${cutTimes.map((t) => t.toFixed(2)).join(", ") || "none"}; boundaries ${expectedBoundaries.map((b) => b.toFixed(2)).join(", ")}; strays: ${strays})`
);

// ---------- 2) SFX presence ----------
console.log("SFX mix check");
const loud = (file, from, to) => run("ffmpeg", ["-ss", String(from), "-to", String(to), "-i", file, "-af", "volumedetect", "-f", "null", "-"], { timeout: 60_000 })
  .then((o) => Number((`${o.stderr}`.match(/max_volume: (-?[\d.]+) dB/) ?? [])[1] ?? -99));
const sfxPeak = await loud(SEG, 0.05, 0.45); // SFX envelope window (fade-in peaks ~0.3s; voice at 0.35s+)
const midPeak = await loud(SEG, 3, 4); // voice-only window
check("SFX clearly audible at scene start", sfxPeak > -13, `(start peak ${sfxPeak} dB, mid ${midPeak} dB)`);

// control: same segment WITHOUT the sfx input must be near-silent in that window
const SEGCTL = path.join(TMP, "segctl.mp4");
await ffmpeg([
  "-loop", "1", "-framerate", String(FPS), "-t", DUR.toFixed(3), "-i", IMG,
  "-i", VOICE,
  "-filter_complex", `${graph};[1:a]adelay=350:all=1,apad[voice];[voice]anull[a]`,
  "-map", "[v]", "-map", "[a]",
  "-t", DUR.toFixed(3), "-r", String(FPS),
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
  "-y", SEGCTL,
], "control segment (no sfx)");
const ctlPeak = await loud(SEGCTL, 0.05, 0.35);
check("SFX is the dominant start signal", sfxPeak - ctlPeak > 15, `(with ${sfxPeak} dB vs without ${ctlPeak} dB, Δ=${(sfxPeak - ctlPeak).toFixed(1)} dB)`);

// ---------- 3) music ducking graph ----------
console.log("music ducking (sidechaincompress)");
const DRONE = "aevalsrc=0.10*sin(2*PI*55*t)+0.07*sin(2*PI*110.4*t)+0.05*sin(2*PI*164.8*t):s=48000";
// Measure the BED ALONE (sidechain still fed by the voice): ducked while
// speech plays 0-4s, released back once the voice goes silent.
const DUCK = path.join(TMP, "ducked.wav");
await ffmpeg([
  "-f", "lavfi", "-t", "8", "-i", "anoisesrc=color=white:r=48000:amplitude=0.5:duration=8,afade=t=out:st=3.8:d=0.2",
  "-f", "lavfi", "-t", "8", "-i", DRONE,
  "-filter_complex",
  "[0:a]aformat=channel_layouts=stereo[sc];[1:a]aformat=channel_layouts=stereo[music];[music][sc]sidechaincompress=threshold=0.03:ratio=9:attack=25:release=450[mduck]",
  "-map", "[mduck]", "-t", "8", "-ar", "48000", "-ac", "2", "-y", DUCK,
], "ducking graph (bed isolated)");
const bedDuring = await loud(DUCK, 1, 3); // bed ducked under speech
const bedAfter = await loud(DUCK, 5, 7); // bed released
check("bed ducks under speech, swells in the gaps", bedAfter - bedDuring > 6, `(ducked ${bedDuring} dB vs released ${bedAfter} dB, Δ=${(bedAfter - bedDuring).toFixed(1)} dB)`);

// ---------- 4) single-shot fallback (short scene, no sfx) ----------
console.log("short scene (2.2s, no sfx)");
const { graph: g2, shotCount: sc2 } = multiShotFilter(2.2, "pan-left", false);
check("short scene gets 1 shot", sc2 === 1, `(got ${sc2})`);
const SEG2 = path.join(TMP, "seg2.mp4");
await ffmpeg([
  "-loop", "1", "-framerate", String(FPS), "-t", "2.2", "-i", IMG,
  "-i", VOICE,
  "-filter_complex", `${g2};[1:a]adelay=350:all=1,apad[voice];[voice]anull[a]`,
  "-map", "[v]", "-map", "[a]",
  "-t", "2.2", "-r", String(FPS),
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
  "-y", SEG2,
], "short segment");
const bf2 = await run("ffmpeg", ["-i", SEG2, "-vf", "blackframe=amount=98:threshold=32", "-f", "null", "-"], { timeout: 60_000 }).catch((e) => e);
check("short segment zero black frames", !/Parsed_blackframe/.test(`${bf2.stderr}${bf2.stdout}`), "");

console.log(`\n${pass} PASS / ${fail} FAIL`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
