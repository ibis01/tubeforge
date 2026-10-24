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
import { getZAI, withRetry, videoDir } from "./ai";

const execFileAsync = promisify(execFile);
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

const FPS = 30;
const LEAD_SEC = 0.35; // silence before narration starts in each scene
const TAIL_SEC = 0.85; // breathing room after narration ends
const MIN_SEG_SEC = 2.0;
const SUBTITLE_STYLE =
  "FontName=Noto Sans SC,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H64000000,BorderStyle=1,Outline=1.4,Shadow=0,Alignment=2,MarginV=30";

export interface RenderOptions {
  videoId: string;
  scenes: Scene[];
  mode: "kenburns" | "animated";
  burnSubtitles: boolean;
  music: boolean;
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

// ---------- Ken Burns ----------

/** Smooth zoompan expressions for each camera direction (N = total frames). */
function kenBurnsFilter(camera: string, totalFrames: number): string {
  const last = Math.max(totalFrames - 1, 1); // avoid divide-by-zero
  const centeredX = "iw/2-(iw/zoom)/2";
  const centeredY = "ih/2-(ih/zoom)/2";
  switch (camera) {
    case "zoom-out":
      return `z='1.13-0.13*on/${last}':x='${centeredX}':y='${centeredY}'`;
    case "pan-right":
      return `z='1.10':x='(iw-iw/zoom)*on/${last}':y='${centeredY}'`;
    case "pan-left":
      return `z='1.10':x='(iw-iw/zoom)*(1-on/${last})':y='${centeredY}'`;
    case "push-in":
      return `z='1+0.22*on/${last}':x='${centeredX}':y='${centeredY}'`;
    case "zoom-in":
    default:
      return `z='1+0.13*on/${last}':x='${centeredX}':y='${centeredY}'`;
  }
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

  const zai = await getZAI();
  const clip = await withRetry(
    `scene ${scene.index} i2v`,
    async () => {
      const submit = await zai.video.generations.create({
        model: "cogvideox-3",
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
    2, // one retry — these are long calls
    8000
  );

  return clip;
}

// ---------- Segments & assembly ----------

/** Build one scene segment: visual track of exactly `dur` + narration audio. */
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

  const audioChain = `[1:a]adelay=${leadMs}:all=1,apad[a]`;
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
    const totalFrames = Math.max(Math.round(dur * FPS), 2);
    const kb = kenBurnsFilter(scene.camera, totalFrames);
    await run("ffmpeg", [
      "-loop", "1", "-framerate", String(FPS), "-t", dur.toFixed(3), "-i", img,
      "-i", wav,
      "-filter_complex",
      `[0:v]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,` +
        `zoompan=${kb}:d=1:s=1920x1080:fps=${FPS},format=yuv420p[v];${audioChain}`,
      ...common,
    ]);
  } else {
    const clip = await ensureSceneClip(opts.videoId, scene);
    await run("ffmpeg", [
      "-stream_loop", "-1", "-t", dur.toFixed(3), "-i", clip,
      "-i", wav,
      "-filter_complex", `[0:v]null[v];${audioChain}`,
      ...common,
    ]);
  }
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

  // Warm ambient drone (A1 + detuned A2 + E3) under the narration.
  const drone =
    "aevalsrc=0.10*sin(2*PI*55*t)+0.07*sin(2*PI*110.4*t)+0.05*sin(2*PI*164.8*t):s=48000";
  if (music) {
    filters.push(
      "[0:a]aformat=channel_layouts=stereo[voice]",
      `[1:a]aformat=channel_layouts=stereo,afade=t=in:d=3,` +
        `afade=t=out:st=${Math.max(total - 4, 0).toFixed(2)}:d=4[music]`,
      "[voice][music]amix=inputs=2:duration=first:weights='1 0.32',alimiter=limit=0.95[a]"
    );
  } else {
    filters.push("[0:a]anull[a]");
  }

  const args = ["-i", base];
  if (music) args.push("-f", "lavfi", "-t", total.toFixed(3), "-i", drone);

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
      fs.writeFileSync(srtPath, buildSrtFromSegments(scenes, segments));
    }
    report(scenes.length, "Adding captions & music");
    await finalize({
      base: basePath,
      out: outPath,
      burnSubtitles: opts.burnSubtitles,
      music: opts.music,
      srtPath,
      scenes,
      segments,
    });

    // Always refresh the exported caption track for the ZIP (full render only).
    if (!isPreview) {
      fs.writeFileSync(path.join(dir, "subtitles.srt"), buildSrtFromSegments(scenes, segments));
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
