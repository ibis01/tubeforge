// Auto-Shorts (Phase 5) — cut a 9:16 vertical clip out of the rendered video.
//
// The best scene is auto-picked (or the user pins one), the matching segment
// of final.mp4 is center-cropped to vertical with a subtle punch-in zoom,
// captions are re-burned big and vertical-safe, and everything fades out
// cleanly at the end. Output: short.mp4 (1080x1920) + short-thumb.png.
//
// Duration is capped at 45s so the cut always qualifies as a YouTube Short.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { Scene } from "./types";
import { sceneImageFile } from "./story";
import { videoDir } from "./ai";
import { focalForScene, sanitizeMotion, type MotionSettings } from "./motion";
import { sanitizeTransition } from "./transitions";

const execFileAsync = promisify(execFile);

const FPS = 30;
const MAX_SHORT_SEC = 45;

/** Vertical caption style — big, bold, inside the Shorts safe zone. */
const SHORT_CAPTION_STYLE =
  "FontName=Noto Sans SC,FontSize=19,Bold=1,PrimaryColour=&H00FFFFFF," +
  "OutlineColour=&H8C000000,BorderStyle=1,Outline=2.2,Shadow=0,Alignment=2,MarginV=190";

async function run(bin: string, args: string[], timeoutMs = 6 * 60 * 1000): Promise<string> {
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

async function probeDuration(file: string): Promise<number> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    file,
  ]);
  const parsed = JSON.parse(out) as { format?: { duration?: string } };
  const d = Number(parsed.format?.duration ?? 0);
  if (!Number.isFinite(d) || d <= 0)
    throw new Error(`Could not probe duration of ${path.basename(file)}`);
  return d;
}

/** Pixel dimensions of the first video stream. */
async function probeDims(file: string): Promise<{ w: number; h: number }> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    file,
  ]);
  const parsed = JSON.parse(out) as { streams?: { width?: number; height?: number }[] };
  const w = Number(parsed.streams?.[0]?.width ?? 0);
  const h = Number(parsed.streams?.[0]?.height ?? 0);
  if (!w || !h) throw new Error(`Could not probe dimensions of ${path.basename(file)}`);
  return { w, h };
}

// ---------- scene selection ----------

/**
 * Deterministic "most punchable scene" heuristic — favors scenes with dense,
 * vivid narration and captions that carry numbers/questions/superlatives
 * (retention hooks). Pure function: same scenes in, same pick out.
 */
export function pickBestScene(scenes: Scene[]): Scene | null {
  if (scenes.length === 0) return null;

  const HOOK = /\d|top|biggest|never|secret|why|how|mistake|truth|nobody|everyone|actually|real/i;

  let best = scenes[0];
  let bestScore = -Infinity;
  for (const scene of scenes) {
    const words = scene.narration.split(/\s+/).filter(Boolean).length;
    let score = Math.min(words, 90); // narration density
    if (HOOK.test(scene.caption)) score += 25; // hook-y caption
    if (HOOK.test(scene.narration.slice(0, 160))) score += 10;
    score += Math.min(scene.caption.length, 40) / 4; // substantive caption
    if (scene.hostInScene) score += 8; // host = face time = retention
    if (score > bestScore) {
      bestScore = score;
      best = scene;
    }
  }
  return best;
}

/** On the final.mp4 timeline, scene N occupies [start, start + dur).
 *  transitionLossSec: when the master was stitched with blended transitions,
 *  each boundary before a scene pulls its content that much earlier — scene
 *  starts shift by −i·loss and non-final scenes lose the blend window at
 *  their tail so cuts stay inside clean content. */
export function sceneTimeline(
  scenes: Scene[],
  wavDurations: number[],
  transitionLossSec = 0
): { scene: Scene; start: number; duration: number }[] {
  // Must mirror render.ts segment math exactly.
  const LEAD_SEC = 0.35;
  const TAIL_SEC = 0.85;
  const MIN_SEG_SEC = 2.0;

  const segDurations = wavDurations.map(
    (d) => Math.max(d + LEAD_SEC + TAIL_SEC, MIN_SEG_SEC)
  );

  let start = 0;
  return scenes.map((scene, i) => {
    const seg = {
      scene,
      start: Math.max(start - i * transitionLossSec, 0),
      duration:
        transitionLossSec > 0 && i < scenes.length - 1
          ? Math.max(segDurations[i] - transitionLossSec, 0.5)
          : segDurations[i],
    };
    start += segDurations[i];
    return seg;
  });
}

// ---------- captions ----------

/** Split narration into Short-sized caption chunks (<= 34 chars when possible). */
function captionChunks(text: string, maxChars = 34): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxChars && current) {
      chunks.push(current.trim());
      current = word;
    } else {
      current = (current ? current + " " : "") + word;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, maxChars)];
}

/** Evenly spread caption chunks across the clip — chunky Shorts-style karaoke. */
function buildShortSrt(chunks: string[], startInVideo: number, totalSec: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (sec: number) => {
    const s = Math.max(0, sec);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(Math.floor(s % 60))},${String(Math.floor((s % 1) * 1000)).padStart(3, "0")}`;
  };

  const per = totalSec / chunks.length;
  return chunks
    .map((text, i) => {
      const from = startInVideo + i * per;
      const to = from + Math.min(per, totalSec - i * per);
      return `${i + 1}\n${fmt(from)} --> ${fmt(to)}\n${text}\n`;
    })
    .join("\n");
}

// ---------- render ----------

export interface ShortRenderResult {
  durationSec: number;
  fileBytes: number;
  sceneIndex: number;
  autoPicked: boolean;
}

export interface ShortRenderOptions {
  videoId: string;
  scenes: Scene[];
  sceneIndex?: number | null; // null/undefined = auto-pick
  /** Smart Motion settings — shape the vertical crop + punch-in. */
  motion?: MotionSettings | null;
  /** Master's scene transitions — cut windows must respect the blended timeline. */
  transition?: { style?: unknown; durationSec?: unknown } | null;
  onProgress?: (label: string) => void;
}

/**
 * Render the vertical Short. Caller (route job) updates the DB afterwards.
 * Requires final.mp4 to exist (the short is cut from the rendered master).
 */
export async function renderShort(opts: ShortRenderOptions): Promise<ShortRenderResult> {
  const dir = videoDir(opts.videoId);
  const finalPath = path.join(dir, "final.mp4");
  if (!fs.existsSync(finalPath))
    throw new Error("Render the final video first — Shorts are cut from the rendered master");

  const scenes = opts.scenes.filter((s) => s.narration && s.visual);
  if (scenes.length === 0) throw new Error("No scenes to cut a Short from");

  const requested =
    opts.sceneIndex != null ? scenes.find((s) => s.index === opts.sceneIndex) : undefined;
  const auto = pickBestScene(scenes);
  const chosen = requested ?? auto;
  if (!chosen) throw new Error(`Scene ${opts.sceneIndex} not found in this video`);
  const autoPicked = requested == null;

  // Rebuild the final.mp4 timeline from the per-scene narration audio.
  opts.onProgress?.("Measuring scene timings");
  const wavDurations = await Promise.all(
    scenes.map((s) => probeDuration(path.join(dir, `scene-${String(s.index).padStart(2, "0")}.wav`)))
  );
  // Blended masters are shorter than the segment math — apply the same shift
  // render.ts uses for captions so cuts land on the chosen scene, not on the
  // tail of the previous dissolve.
  const trans = sanitizeTransition(opts.transition);
  const loss = trans.style !== "cut" && scenes.length > 1 ? trans.durationSec : 0;
  const timeline = sceneTimeline(scenes, wavDurations, loss);
  const seg = timeline.find((t) => t.scene.index === chosen.index)!;

  const totalDur = await probeDuration(finalPath);
  const start = Math.min(seg.start, Math.max(0, totalDur - 1));
  let dur = Math.min(seg.duration, MAX_SHORT_SEC, totalDur - start);
  if (dur < 3)
    throw new Error("The chosen scene is too short to cut a Short from (needs 3s+)");

  // Captions: chunked narration spread across the cut.
  const chunks = captionChunks(chosen.narration);
  const tmpDir = path.join(dir, "short-tmp");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const srtPath = path.join(tmpDir, "short.srt");
  fs.writeFileSync(srtPath, buildShortSrt(chunks, start, dur));

  const fadeOut = Math.min(0.6, dur / 4);

  // Focal-aware vertical framing: a blind center-crop of a 16:9 master into
  // 9:16 throws away ~57% of the width — exactly where faces drift out of
  // frame. The crop window is positioned so the scene's focal point (face /
  // key object, same source as Smart Motion) lands at the CENTER of the
  // vertical frame — the best crop for 16:9 is not the best crop for 9:16.
  const motion = sanitizeMotion(opts.motion ?? null);
  const focal = focalForScene(chosen);
  const { w, h } = await probeDims(finalPath);
  const cover = Math.max(1080 / w, 1920 / h);
  const scaledW = Math.max(1080, Math.round(w * cover));
  const scaledH = Math.max(1920, Math.round(h * cover));
  const cropX = Math.min(Math.max(Math.round(focal.x * scaledW - 540), 0), Math.max(scaledW - 1080, 0));
  const cropY = Math.min(Math.max(Math.round(focal.y * scaledH - 960), 0), Math.max(scaledH - 1920, 0));

  opts.onProgress?.(`Cutting scene ${chosen.index} vertical`);

  // Punch-in: focal-centered 9:16 cover crop, upscale, then a smooth eased
  // creep (cosine easing like the master render; amplitude from the video's
  // motion intensity, clamped to a Short-friendly range). Working at 2x
  // target resolution keeps the zoompan sub-pixel smooth; every intermediate
  // stays integer-sized (fractional crop w would make ffmpeg throw).
  const last = Math.max(Math.round(dur * FPS) - 1, 1);
  const amp = Math.min(Math.max(motion.intensity, 0) / 100, 0.16);
  const ease = motion.curve === "linear" ? `on/${last}` : `(0.5-0.5*cos(PI*on/${last}))`;
  const zf = motion.intensity < 1 ? "1" : `1+${amp.toFixed(4)}*${ease}`;
  const vf =
    `scale=${scaledW}:${scaledH},crop=1080:1920:${cropX}:${cropY},` +
    `scale=2160:3840:flags=lanczos,` +
    `zoompan=z='${zf}':` +
    `x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=1:s=1080x1920:fps=${FPS},` +
    `format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st=${(dur - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)},` +
    `subtitles=f='${srtPath.replace(/\\/g, "/").replace(/'/g, "\\'")}':force_style='${SHORT_CAPTION_STYLE}'`;

  const outPath = path.join(dir, "short.mp4");
  await run("ffmpeg", [
    "-ss", start.toFixed(3),
    "-t", dur.toFixed(3),
    "-i", finalPath,
    "-vf", vf,
    "-af", `afade=t=in:st=0:d=0.3,afade=t=out:st=${(dur - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}`,
    "-r", String(FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    "-y", outPath,
  ]);

  // Vertical thumbnail from the scene's storyboard art.
  opts.onProgress?.("Framing the vertical cover");
  const sceneImg = path.join(dir, sceneImageFile(chosen.index));
  const thumbPath = path.join(dir, "short-thumb.png");
  if (fs.existsSync(sceneImg)) {
    await run("ffmpeg", [
      "-i", sceneImg,
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
      "-frames:v", "1",
      "-y", thumbPath,
    ], 60 * 1000).catch(() => {}); // best-effort cover
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const shortDur = await probeDuration(outPath);
  return {
    durationSec: shortDur,
    fileBytes: fs.statSync(outPath).size,
    sceneIndex: chosen.index,
    autoPicked,
  };
}

/** Read short.mp4 for the streaming route (null when none rendered). */
export function readShortFile(videoId: string): { buffer: Buffer; fileName: string } | null {
  const p = path.join(process.cwd(), "uploads", videoId, "short.mp4");
  if (!fs.existsSync(p)) return null;
  return { buffer: fs.readFileSync(p), fileName: "short.mp4" };
}

/** Read short-thumb.png (null when absent). */
export function readShortThumb(videoId: string): Buffer | null {
  const p = path.join(process.cwd(), "uploads", videoId, "short-thumb.png");
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}
