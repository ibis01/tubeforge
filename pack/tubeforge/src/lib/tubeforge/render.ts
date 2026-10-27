// Video compositor — assembles the final MP4 from storyboard art + per-scene
// voiceover using ffmpeg, in two modes:
//   • kenburns  — cinematic pans/zooms over still art (fast, ~realtime/3)
//   • animated  — every scene animated via CogVideoX image-to-video (~4 min/scene)
// Pipeline: per-scene segments (video+audio) -> concat -> subtitles/music pass.
// All commands run via execFile (no shell) so filter strings need only
// ffmpeg-internal quoting, never shell quoting.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { Scene } from "./types";
import { sceneImageFile, sceneWavFile, buildSrtFromSegments } from "./story";
import { buildSmartSrt } from "./captions";
import { getZAI, videoDir } from "./ai";
import { aiCall } from "./budget";
import { ensureSfx } from "./sfx";
import { getCapability, VIDEO_DEFAULT_MODEL } from "./providers/settings";

const execFileAsync = promisify(execFile);
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

const FPS = 30;
const LEAD_SEC = 0.35; // silence before narration starts in each scene
const TAIL_SEC = 0.85; // breathing room after narration ends
const MIN_SEG_SEC = 2.0;
const SHOT_SEC = 2.7; // target length of each Ken Burns shot — a visible
// camera cut lands at least every ~3s (retention rule)
const MAX_SHOTS = 12; // safety cap for pathologically long scenes
const SUBTITLE_STYLE =
  "FontName=Noto Sans SC,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H64000000,BorderStyle=1,Outline=1.4,Shadow=0,Alignment=2,MarginV=30";
/** Subtle finishing grade — a touch of contrast/saturation + soft vignette. */
const GRADE = "eq=contrast=1.05:saturation=1.08,vignette=PI/5";

export interface RenderOptions {
  videoId: string;
  scenes: Scene[];
  mode: "kenburns" | "animated";
  burnSubtitles: boolean;
  smartCaptions: boolean; // audio-synced cues (silence + ASR alignment) vs one caption per scene
  music: boolean;
  musicNiche?: string; // selects the per-niche music bed profile
  sceneLimit?: number; // render only the first N scenes (preview render)
  onProgress?: (current: number, total: number, label: string) => void;
}

export interface RenderResult {
  fileName: "final.mp4" | "preview.mp4";
  durationSec: number;
  fileBytes: number;
}

/** Run ffmpeg/ffprobe, surfacing the useful tail of stderr on failure. */
async function run(
  bin: string,
  args: string[],
  timeoutMs = 10 * 60 * 1000
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.toString() || stderr.toString();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const tail = (e.stderr ?? e.message ?? "").split("\n").slice(-6).join("\n");
    throw new Error(`${bin} failed: ${tail.slice(0, 600)}`);
  }
}

/** Media duration in seconds via ffprobe. */
export async function probeDuration(file: string): Promise<number> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    file,
  ]);
  const parsed = JSON.parse(out) as { format?: { duration?: string } };
  const d = Number(parsed.format?.duration ?? 0);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`Could not probe duration of ${path.basename(file)}`);
  return d;
}

// ---------- Ken Burns (multi-shot) ----------

/**
 * Per-shot camera moves. Every variant is tuned for SHORT shots (≤3s) so cuts
 * feel like a real multi-cam edit: zooms are snappy, pans sweep a wide range,
 * and each shot's framing deliberately JUMPS from the previous one.
 *
 * Amplitude matters more than frequency: forensic diffing of real renders
 * showed that a 1.04↔1.14 zoom flip (~10% FOV) is visually INVISIBLE on dark
 * or low-texture art — viewers (and detectors) read the scene as frozen.
 * Every variant below jumps at least ~35% of field-of-view across a cut
 * (wide ≈ z1.0 vs tight ≈ z1.4), which reads as a hard cut on ANY image.
 */
function kenBurnsFilter(variant: string, totalFrames: number, zStart: number): string {
  const last = Math.max(totalFrames - 1, 1); // avoid divide-by-zero
  const centeredX = "iw/2-(iw/zoom)/2";
  const centeredY = "ih/2-(ih/zoom)/2";
  // Pans/tilts sweep 70% of the travel range (15% → 85%) — brisk at 2.7s
  // instead of the glacial full-range drift a long scene used to get.
  const panX = (fwd: boolean) =>
    fwd ? "(iw-iw/zoom)*(0.15+0.7*on/" + last + ")" : "(iw-iw/zoom)*(0.85-0.7*on/" + last + ")";
  const panY = (fwd: boolean) =>
    fwd ? "(ih-ih/zoom)*(0.15+0.7*on/" + last + ")" : "(ih-ih/zoom)*(0.85-0.7*on/" + last + ")";
  switch (variant) {
    case "zoom-out":
      return `z='1.42-0.4*on/${last}':x='${centeredX}':y='${centeredY}'`;
    case "pan-right":
      return `z='${zStart.toFixed(2)}':x='${panX(true)}':y='${centeredY}'`;
    case "pan-left":
      return `z='${zStart.toFixed(2)}':x='${panX(false)}':y='${centeredY}'`;
    case "tilt-down":
      return `z='${zStart.toFixed(2)}':x='${centeredX}':y='${panY(true)}'`;
    case "tilt-up":
      return `z='${zStart.toFixed(2)}':x='${centeredX}':y='${panY(false)}'`;
    case "push-in":
      return `z='1.02+0.38*on/${last}':x='${centeredX}':y='${centeredY}'`;
    case "punch": {
      // Rehook opener — fast attack (1.32 → 1.14 over 0.45s) then a slow
      // drift. Reads as an impact frame the instant the scene lands.
      const f = Math.max(Math.round(0.45 * FPS), 2);
      return `z='if(lte(on\\,${f})\\,1.32-0.18*on/${f}\\,1.14+0.06*(on-${f})/${Math.max(last - f, 1)})':x='${centeredX}':y='${centeredY}'`;
    }
    case "zoom-in":
    default:
      return `z='1+0.4*on/${last}':x='${centeredX}':y='${centeredY}'`;
  }
}

/** End-state zoom of a variant (used to force a framing jump at the next cut). */
function endZoomOf(variant: string, zStart: number): number {
  switch (variant) {
    case "zoom-in": return 1.4;
    case "zoom-out": return 1.02;
    case "push-in": return 1.4;
    case "punch": return 1.2;
    default: return zStart; // pans/tilts hold a constant zoom
  }
}

/**
 * Shot plan for one scene: the scene's own camera direction opens, then a
 * rotating mix of moves that never repeats back-to-back. Pans/tilts get a
 * start zoom OPPOSITE to the previous shot's end zoom (wide↔tight), so every
 * cut shows a clearly visible reframe of the same artwork.
 * Rehook scenes open with the punch move instead.
 */
function shotSequence(camera: string, shotCount: number, rehook: boolean): { id: string; zStart: number }[] {
  const rotation = ["zoom-in", "pan-right", "zoom-out", "tilt-down", "push-in", "pan-left", "zoom-out", "tilt-up"];
  const first = rehook && camera !== "punch" ? "punch" : camera;
  const isPan = (id: string) => ["pan-right", "pan-left", "tilt-down", "tilt-up"].includes(id);

  /**
   * Start zoom per variant + side of the wide↔tight flip.
   * Pans/tilts are special: their only motion IS the pan, and pan travel is
   * (iw - iw/zoom) — at z=1.02 that's ~2% of the frame, i.e. FROZEN. Pans
   * therefore always start between 1.22 and 1.36, where a 2.7s sweep moves
   * ~10-14% of the frame — clearly visible on any artwork.
   */
  const startZoomFor = (id: string, wantWide: boolean): number => {
    if (isPan(id)) return wantWide ? 1.22 : 1.36;
    return wantWide ? 1.0 : 1.38;
  };

  const shots: { id: string; zStart: number }[] = [
    { id: first, zStart: isPan(first) ? 1.3 : 1.0 },
  ];
  let i = 0;
  while (shots.length < shotCount) {
    const next = rotation[i++ % rotation.length];
    if (next === shots[shots.length - 1].id) continue;
    // Wide↔tight flip: start opposite to where the previous shot ended so
    // every cut is a ~35-40% FOV jump — a visible reframe on any artwork.
    const prevEnd = endZoomOf(shots[shots.length - 1].id, shots[shots.length - 1].zStart);
    shots.push({ id: next, zStart: startZoomFor(next, prevEnd <= 1.12) });
  }
  return shots;
}

/**
 * Build the multi-shot visual filter graph for one scene: the scene image is
 * split into N sub-streams, each trimmed to its shot range and driven by its
 * own zoompan move, then concat'd — hard camera cuts WITHOUT extra images.
 * The finishing grade runs over the whole chain.
 */
function multiShotFilter(dur: number, scene: Scene): string {
  const totalFrames = Math.max(Math.round(dur * FPS), 2);
  const shotCount = Math.max(1, Math.min(MAX_SHOTS, Math.round(dur / SHOT_SEC)));
  const variants = shotSequence(scene.camera, shotCount, scene.rehook);

  // Frames per shot — the last shot absorbs the rounding remainder.
  const per = Math.max(Math.floor(totalFrames / shotCount), 2);
  const bounds: number[] = [];
  for (let i = 1; i < shotCount; i++) bounds.push(Math.min(per * i, totalFrames - 1));

  const parts: string[] = [
    `[0:v]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,split=${shotCount}${
      variants.map((_, i) => `[s${i}]`).join("")
    }`,
  ];

  let start = 0;
  variants.forEach(({ id, zStart }, i) => {
    const end = i < variants.length - 1 ? bounds[i] : totalFrames;
    const frames = Math.max(end - start, 2);
    const kb = kenBurnsFilter(id, frames, zStart);
    parts.push(
      `[s${i}]trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS,` +
        `zoompan=${kb}:d=1:s=1920x1080:fps=${FPS},format=yuv420p[v${i}]`
    );
    start = end;
  });

  parts.push(
    `${variants.map((_, i) => `[v${i}]`).join("")}concat=n=${shotCount}:v=1:a=0[vc]`,
    `[vc]${GRADE}[v]`
  );
  return parts.join(";");
}

// ---------- Animated (CogVideoX i2v) ----------

/** Motion prompt describing how the scene should animate. */
function motionPrompt(scene: Scene): string {
  const cameraMotion: Record<string, string> = {
    "zoom-in": "slow cinematic zoom in",
    "zoom-out": "slow cinematic zoom out revealing the scene",
    "pan-left": "smooth camera pan to the left",
    "pan-right": "smooth camera pan to the right",
    "push-in": "steady dramatic push in toward the subject",
  };
  const motion = cameraMotion[scene.camera] ?? "subtle cinematic camera drift";
  return `${motion}. ${scene.visual}. ${scene.mood}. Natural ambient motion, cinematic quality, no text.`;
}

/**
 * Generate (or reuse a cached) 5s animated clip for one scene via
 * CogVideoX image-to-video, seeded from the storyboard image.
 */
async function ensureSceneClip(videoId: string, scene: Scene): Promise<string> {
  const clipPath = path.join(videoDir(videoId), `scene-${String(scene.index).padStart(2, "0")}.mp4`);
  if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 10_000) return clipPath;

  const imagePath = path.join(UPLOAD_ROOT, videoId, sceneImageFile(scene.index));
  const imageB64 = fs.readFileSync(imagePath).toString("base64");

  // Video generation is Z.ai CogVideoX — validate the provider up front so
  // misconfigured installs fail with a actionable message instead of an
  // opaque SDK error deep inside the render.
  const videoConfig = await getCapability("video");
  if (videoConfig.provider !== "zai") {
    throw new Error(
      "Scene animation only supports Z.ai CogVideoX — fix it in Settings → AI Providers, or render with Ken Burns mode (no AI video needed)"
    );
  }
  const videoModel = videoConfig.model?.trim() || VIDEO_DEFAULT_MODEL;

  const zai = await getZAI();
  const clip = await aiCall(
    "video",
    `scene ${scene.index} i2v`,
    async () => {
      const submit = await zai.video.generations.create({
        model: videoModel,
        prompt: motionPrompt(scene),
        image_url: `data:image/png;base64,${imageB64}`,
        quality: "speed",
        with_audio: false,
        duration: 5,
        fps: FPS,
        size: "1920x1080",
      });

      // Poll the async task (i2v takes ~3-5 min per clip)
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        const res = await zai.async.result.query(submit.id);
        const status = res.task_status;
        const url = res.video_result?.[0]?.url ?? res.video_url ?? null;
        if (status === "SUCCESS" && url) {
          const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
          if (buf.length < 10_000) throw new Error("i2v returned an empty clip");
          fs.writeFileSync(clipPath, buf);
          return clipPath;
        }
        if (status === "FAIL") throw new Error(`i2v task failed for scene ${scene.index}`);
      }
      throw new Error(`i2v task timed out for scene ${scene.index}`);
    },
    { attempts: 2, baseDelayMs: 8000 } // one retry — these are long calls
  );

  return clip;
}

// ---------- Per-niche music beds ----------

/**
 * A synthesized ambient bed profile. Each niche gets its own tonal center,
 * interval stack, breathing rate and filter so a Motivation video doesn't
 * sound like a Mysteries one. All beds are slow evolving pads — they sit
 * UNDER narration (ducked later) and must never carry a melody or rhythm
 * that competes with the voice.
 */
interface MusicProfile {
  /** Stacked sine partials (Hz) with relative gains — root + color intervals. */
  partials: [freq: number, gain: number][];
  /** Breathing LFO rate (Hz) + depth (0-1) — how much the pad swells. */
  lfoRate: number;
  lfoDepth: number;
  /** Lowpass ceiling (Hz) — lower = darker, further from the voice band. */
  lowpassHz: number;
  /** Bed gain before ducking. */
  level: number;
}

const MUSIC_PROFILES: Record<string, MusicProfile> = {
  // Warm uplifting A-minor stack with a slow sunrise swell.
  Motivation: {
    partials: [[55, 0.05], [110.4, 0.034], [164.8, 0.02], [220.5, 0.012]],
    lfoRate: 0.07, lfoDepth: 0.22, lowpassHz: 1000, level: 1.0,
  },
  // Light, curious C-major-ish stack, a touch brighter and quicker.
  "Fun Facts": {
    partials: [[65.4, 0.05], [130.8, 0.032], [196.2, 0.022], [261.8, 0.011]],
    lfoRate: 0.11, lfoDepth: 0.18, lowpassHz: 1200, level: 0.95,
  },
  // Solemn epic D — low, wide, slowest breathing in the catalog.
  History: {
    partials: [[36.7, 0.055], [73.4, 0.036], [110.2, 0.02], [146.9, 0.012]],
    lfoRate: 0.05, lfoDepth: 0.26, lowpassHz: 850, level: 1.0,
  },
  // Cold minimal G — sparse, steady, businesslike.
  Finance: {
    partials: [[49.0, 0.05], [98.1, 0.03], [147.0, 0.018]],
    lfoRate: 0.06, lfoDepth: 0.14, lowpassHz: 800, level: 0.9,
  },
  // Introspective E — soft, round, slightly airy.
  Psychology: {
    partials: [[41.2, 0.05], [82.4, 0.033], [123.5, 0.02], [164.8, 0.01]],
    lfoRate: 0.08, lfoDepth: 0.2, lowpassHz: 950, level: 0.95,
  },
  // Vast airy A fifth — space, orbital, weightless.
  "Space & Science": {
    partials: [[55.0, 0.05], [82.5, 0.03], [110.0, 0.022], [165.2, 0.01]],
    lfoRate: 0.06, lfoDepth: 0.24, lowpassHz: 1100, level: 1.0,
  },
  // Clean neutral F fifth — precise, digital, unobtrusive.
  Technology: {
    partials: [[58.3, 0.05], [116.6, 0.03], [174.7, 0.018]],
    lfoRate: 0.09, lfoDepth: 0.15, lowpassHz: 1150, level: 0.9,
  },
  // Dark F#-C tension — unease without ever becoming a jump-scare.
  Mysteries: {
    partials: [[46.2, 0.05], [69.3, 0.034], [92.6, 0.02], [139.0, 0.012]],
    lfoRate: 0.045, lfoDepth: 0.28, lowpassHz: 780, level: 1.0,
  },
};

const DEFAULT_MUSIC_PROFILE: MusicProfile = MUSIC_PROFILES.Motivation;

/** Pick the ambient bed for a video niche (unknown niches get the default). */
export function musicProfileForNiche(niche: string | undefined | null): MusicProfile {
  return (niche && MUSIC_PROFILES[niche]) || DEFAULT_MUSIC_PROFILE;
}

/** Build the aevalsrc expression for a profile's breathing pad. */
function droneSource(profile: MusicProfile): string {
  const tones = profile.partials
    .map(([f, g]) => `${g.toFixed(4)}*sin(2*PI*${f}*t)`)
    .join("+");
  const breath = `(1-${profile.lfoDepth.toFixed(2)}+${profile.lfoDepth.toFixed(2)}*sin(2*PI*${profile.lfoRate}*t))`;
  return `aevalsrc='(${tones})*${breath}':s=48000`;
}

// ---------- Segments & assembly ----------

/** Build one scene segment: visual track of exactly `dur` + narration audio (+ SFX cue). */
async function buildSegment(opts: {
  videoId: string;
  scene: Scene;
  dur: number;
  mode: "kenburns" | "animated";
  outPath: string;
}): Promise<void> {
  const { scene, dur, mode, outPath } = opts;
  const dir = videoDir(opts.videoId);
  const wav = path.join(dir, sceneWavFile(scene.index));
  const leadMs = Math.round(LEAD_SEC * 1000);

  const common = [
    "-map", "[v]", "-map", "[a]",
    "-t", dur.toFixed(3),
    "-r", String(FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    "-y", outPath,
  ];

  if (mode === "kenburns") {
    const img = path.join(dir, sceneImageFile(scene.index));
    const vChain = multiShotFilter(dur, scene);
    const aChain = await sceneAudioChain(opts.videoId, scene, leadMs);
    await run("ffmpeg", [
      "-loop", "1", "-framerate", String(FPS), "-t", dur.toFixed(3), "-i", img,
      "-i", wav,
      ...(await sfxInputs(opts.videoId, scene)),
      "-filter_complex", `${vChain};${aChain}`,
      ...common,
    ]);
  } else {
    const clip = await ensureSceneClip(opts.videoId, scene);
    const aChain = await sceneAudioChain(opts.videoId, scene, leadMs);
    await run("ffmpeg", [
      "-stream_loop", "-1", "-t", dur.toFixed(3), "-i", clip,
      "-i", wav,
      ...(await sfxInputs(opts.videoId, scene)),
      "-filter_complex", `[0:v]${GRADE}[v];${aChain}`,
      ...common,
    ]);
  }
}

/**
 * Audio graph for one scene: narration delayed to its lead-in, optionally
 * mixed with the scene's synthesized SFX cue fired right at the cut.
 */
async function sceneAudioChain(
  videoId: string,
  scene: Scene,
  leadMs: number
): Promise<string> {
  const voice = `[1:a]adelay=${leadMs}:all=1,apad[voice]`;
  const sfxPath = await ensureSfx(scene.sfx);
  if (!sfxPath) return `${voice};[voice]anull[a]`;
  // SFX lands 40 ms after the cut so the impact sits with the first frame,
  // not in the file's leading edge; ride ~9 dB under the narration — these
  // are synthesized accents, and mixing them hot makes the edit sound like a
  // test bench instead of a film. normalize=0 keeps the weights as literal
  // gains (default normalization would scale BOTH sources down by 1/(1+w)).
  return `${voice};[2:a]adelay=40:all=1[sfx];` +
    `[voice][sfx]amix=inputs=2:duration=first:normalize=0:weights='1 0.35'[a]`;
}

/** ffmpeg input args for the scene's SFX cue (empty when the scene has none). */
async function sfxInputs(videoId: string, scene: Scene): Promise<string[]> {
  const sfxPath = await ensureSfx(scene.sfx);
  return sfxPath ? ["-i", sfxPath] : [];
}

/** Concat segment files (identical codecs) into one MP4. */
async function concatSegments(segPaths: string[], outPath: string): Promise<void> {
  const listFile = outPath.replace(/\.mp4$/, "-list.txt");
  fs.writeFileSync(listFile, segPaths.map((p) => `file '${p}'`).join("\n") + "\n");
  await run("ffmpeg", ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-y", outPath]);
  fs.rmSync(listFile, { force: true });
}

/**
 * Final pass — burn subtitles and/or lay a soft ambient music bed under the
 * narration, with faststart for instant web playback. Skips re-encoding when
 * neither effect is requested.
 */
async function finalize(opts: {
  base: string;
  out: string;
  burnSubtitles: boolean;
  music: boolean;
  musicNiche?: string;
  srtPath: string | null;
  scenes: Scene[];
  segments: { start: number; duration: number }[];
}): Promise<void> {
  const { base, out, burnSubtitles, music } = opts;

  if (!burnSubtitles && !music) {
    // Pure remux — put the moov atom up front for streaming playback.
    await run("ffmpeg", ["-i", base, "-c", "copy", "-movflags", "+faststart", "-y", out]);
    return;
  }

  const total = await probeDuration(base);
  const filters: string[] = [];

  if (burnSubtitles && opts.srtPath) {
    filters.push(
      `[0:v]subtitles=f='${opts.srtPath}':force_style='${SUBTITLE_STYLE}'[v]`
    );
  } else {
    filters.push("[0:v]null[v]");
  }

  if (music) {
    // Per-niche ambient bed (see MUSIC_PROFILES): each niche gets its own
    // tonal center + breathing rate, DUCKED by the voice itself via
    // sidechain compression — the bed swells in narration gaps and drops
    // hard while anyone is speaking (broadcast-style ducking). The lowpass
    // keeps it a soft pad below the voice band rather than an audible hum.
    const profile = musicProfileForNiche(opts.musicNiche);
    filters.push(
      "[0:a]aformat=channel_layouts=stereo,asplit=2[voice][sc]",
      `[1:a]aformat=channel_layouts=stereo,lowpass=f=${profile.lowpassHz},afade=t=in:d=3,` +
        `afade=t=out:st=${Math.max(total - 4, 0).toFixed(2)}:d=4[music]`,
      `[music][sc]sidechaincompress=threshold=0.03:ratio=9:attack=25:release=450[mduck]`,
      // Master chain: mix bed under voice, normalize to YouTube's loudness
      // target (-14 LUFS integrated, -1.5 dBTP) so every upload lands at a
      // consistent, broadcast-clean level, then a safety limiter.
      `[voice][mduck]amix=inputs=2:duration=first:normalize=0:weights='1 0.85',` +
        `loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.95[a]`
    );
  } else {
    filters.push("[0:a]anull[a]");
  }

  const args = ["-i", base];
  if (music)
    args.push(
      "-f", "lavfi", "-t", total.toFixed(3), "-i", droneSource(musicProfileForNiche(opts.musicNiche))
    );

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]", "-map", "[a]"
  );
  if (burnSubtitles)
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");
  else args.push("-c:v", "copy");
  args.push("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-y", out);

  await run("ffmpeg", args, 15 * 60 * 1000);
}

/** Read the final or preview MP4 (or a byte range of it). */
export function readVideoFile(
  videoId: string,
  variant: "final" | "preview"
): { buffer: Buffer; fileName: string } | null {
  const fileName = variant === "final" ? "final.mp4" : "preview.mp4";
  const p = path.join(UPLOAD_ROOT, videoId, fileName);
  if (!fs.existsSync(p)) return null;
  return { buffer: fs.readFileSync(p), fileName };
}

// ---------- Orchestrator ----------

/** Compose the video. Caller (route job) updates the DB afterwards. */
export async function renderVideo(opts: RenderOptions): Promise<RenderResult> {
  const dir = videoDir(opts.videoId);
  const scenes = opts.sceneLimit
    ? opts.scenes.slice(0, opts.sceneLimit)
    : opts.scenes;
  const isPreview = Boolean(opts.sceneLimit && opts.sceneLimit < opts.scenes.length);
  const outName = isPreview ? "preview.mp4" : "final.mp4";
  const outPath = path.join(dir, outName);

  if (scenes.length === 0) throw new Error("No scenes to render");

  // Validate inputs up-front with actionable messages.
  for (const scene of scenes) {
    if (!fs.existsSync(path.join(dir, sceneImageFile(scene.index))))
      throw new Error(`Scene ${scene.index} has no storyboard image — generate the storyboard first`);
    if (!fs.existsSync(path.join(dir, sceneWavFile(scene.index))))
      throw new Error(`Scene ${scene.index} has no voiceover — generate the voiceover first`);
  }

  const tmpDir = path.join(dir, "render-tmp");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1) Scene timings from the per-scene narration audio.
    const report = (i: number, label: string) =>
      opts.onProgress?.(i + 1, scenes.length + 1, label);

    const wavs = await Promise.all(
      scenes.map((s) => probeDuration(path.join(dir, sceneWavFile(s.index))))
    );
    const durations = wavs.map(
      (d) => Math.max(d + LEAD_SEC + TAIL_SEC, MIN_SEG_SEC)
    );
    const segments = durations.map((d, i) => ({
      start: durations.slice(0, i).reduce((a, b) => a + b, 0),
      duration: d,
    }));

    // 2) One segment per scene (visual + narration audio, exact duration).
    const segPaths: string[] = [];
    for (const [i, scene] of scenes.entries()) {
      report(i, opts.mode === "kenburns" ? `Composing scene ${i + 1}` : `Animating scene ${i + 1}`);
      const segPath = path.join(tmpDir, `seg-${String(i + 1).padStart(2, "0")}.mp4`);
      await buildSegment({
        videoId: opts.videoId,
        scene,
        dur: durations[i],
        mode: opts.mode,
        outPath: segPath,
      });
      segPaths.push(segPath);
    }

    // 3) Concat into the base video.
    report(scenes.length, "Stitching scenes");
    const basePath = path.join(tmpDir, "base.mp4");
    await concatSegments(segPaths, basePath);

    // 4) Subtitles + music, then move into place.
    let srtPath: string | null = null;
    if (opts.burnSubtitles) {
      srtPath = path.join(tmpDir, "captions.srt");
      if (opts.smartCaptions) {
        // Audio-synced cues: ASR word alignment + speech-run detection.
        try {
          report(scenes.length, "Syncing captions to narration");
          const smart = await buildSmartSrt({
            videoId: opts.videoId,
            scenes,
            segments,
            asr: true,
            onProgress: (label) => opts.onProgress?.(scenes.length + 1, scenes.length + 1, label),
          });
          fs.writeFileSync(srtPath, smart.srt);
          console.log(
            `[render] smart captions: ${smart.cueCount} cues (${smart.method}-aligned)`
          );
        } catch (err) {
          console.warn("[render] smart captions failed — falling back to scene captions:", err);
          fs.writeFileSync(srtPath, buildSrtFromSegments(scenes, segments));
        }
      } else {
        fs.writeFileSync(srtPath, buildSrtFromSegments(scenes, segments));
      }
    }
    report(scenes.length, "Adding captions & music");
    await finalize({
      base: basePath,
      out: outPath,
      burnSubtitles: opts.burnSubtitles,
      music: opts.music,
      musicNiche: opts.musicNiche,
      srtPath,
      scenes,
      segments,
    });

    // Always refresh the exported caption track for the ZIP (full render only).
    if (!isPreview) {
      const exportSrt = path.join(dir, "subtitles.srt");
      if (opts.burnSubtitles && srtPath && fs.existsSync(srtPath))
        fs.copyFileSync(srtPath, exportSrt);
      else fs.writeFileSync(exportSrt, buildSrtFromSegments(scenes, segments));
    }

    const durationSec = await probeDuration(outPath);
    return {
      fileName: outName,
      durationSec,
      fileBytes: fs.statSync(outPath).size,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
