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
import { must } from "./must";
import { sceneImageFile } from "./story";
import { videoDir } from "./ai";
import * as storage from "./storage";
import { focalForScene, sanitizeMotion, type MotionSettings } from "./motion";
import { sanitizeTransition } from "./transitions";
import { aiCall } from "./budget";
import { llmChat } from "./llm";
import { parseJsonLoose } from "./ai";

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

// S70 CI-3 — the self-containment scorer (transcript-based moment
// selection, per docs/audits/creator-intelligence-record.md). The old
// heuristic scored keyword density; the record's critique is exact:
// "Moment selection is keyword-scoring, not transcript-based
// self-containment." A Short is a COLD START — the viewer owes the video
// nothing, so the clip must read as a complete thought on its own.
// Deterministic proxies for self-containment, all pure:
//   • a dangling opener ("So that's why…", "But this one…") points
//     BACKWARD at content the clip does not carry;
//   • a pronoun-only subject (it/they/this…) assumes the viewer knows
//     who or what — a cold viewer does not;
//   • hook markers (numbers, questions, superlatives) still count — a
//     self-contained bore is still a bore;
//   • a payoff ending (terminal punctuation, no trailing conjunction)
//     closes the loop instead of dangling into the next scene;
//   • the Shorts speech window (~30-110 words ≈ 12-45 s) fits the format.
export interface SelfContainmentScore {
  score: number;
  selfContained: boolean;
  notes: string[];
  heuristic: true;
}

const DANGLING_OPENERS =
  /^(so|and|but|also|then|that|this|these|those|it|they|he|she|its|their|therefore|however|meanwhile)\b/i;
const PRONOUN_SUBJECTS = /\b(it|they|them|this|that|these|those|he|she|his|her|its|their)\b/gi;
const HOOKY = /\d|top|biggest|never|secret|why|how|mistake|truth|nobody|everyone|actually|real/i;
const TRAILING_CONJUNCTION = /\b(and|but|so|because|which|while)\s*$/i;

/** Score one scene's transcript for Shorts self-containment. PURE. */
export function selfContainmentScore(
  scene: Pick<Scene, "narration" | "caption" | "hostInScene">
): SelfContainmentScore {
  const notes: string[] = [];
  const narration = scene.narration.trim();
  const words = narration.split(/\s+/).filter(Boolean);
  let score = 30; // baseline: a scene is a scene

  // The opener: dangling backward references are the cold-start killer.
  if (DANGLING_OPENERS.test(narration)) {
    score -= 22;
    notes.push("opens on a backward reference (a cold viewer has no antecedent)");
  } else {
    score += 12;
  }

  // The subject: pronouns vs concrete nouns. A scene that never names its
  // subject rides on context the clip cannot carry.
  const pronouns = (narration.match(PRONOUN_SUBJECTS) ?? []).length;
  const hasNumberOrCap = /\b\d|\b[A-Z][a-z]{2,}/.test(narration);
  if (pronouns >= 3 && !hasNumberOrCap) {
    score -= 14;
    notes.push("pronoun-heavy subject — never names who or what");
  } else if (hasNumberOrCap) {
    score += 10;
    notes.push("names a concrete subject");
  }

  // Hook markers — on the caption AND the narration's opening window.
  if (HOOKY.test(scene.caption)) {
    score += 18;
    notes.push("hook-y caption");
  }
  if (HOOKY.test(narration.slice(0, 160))) {
    score += 10;
    notes.push("hook-y narration");
  }
  if (/\?\s*$/.test(narration)) {
    score += 8;
    notes.push("closes on a question");
  }

  // The payoff: terminal punctuation, no trailing conjunction.
  if (/[.!?]$/.test(narration) && !TRAILING_CONJUNCTION.test(narration)) {
    score += 10;
    notes.push("lands a payoff ending");
  } else {
    score -= 6;
    notes.push("ends mid-thought");
  }

  // The Shorts speech window: ~2.6 words/sec → 30-110 words ≈ 12-42 s.
  if (words.length >= 30 && words.length <= 110) {
    score += 12;
  } else if (words.length < 18) {
    score -= 10;
    notes.push("too thin for a standalone clip");
  } else if (words.length > 110) {
    score -= 6;
    notes.push("runs past the Shorts window");
  }

  if (scene.hostInScene) {
    score += 8; // host = face time = retention (unchanged from the old law)
    notes.push("host on screen");
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    selfContained: !DANGLING_OPENERS.test(narration) && pronouns < 3,
    notes,
    heuristic: true,
  };
}

/**
 * The Shorts moment (S70 CI-3): transcript-based SELF-CONTAINMENT scoring
 * replaces keyword density — same pure-function seam, same signature, smarter
 * score. Same scenes in, same pick out; the tie-break stays first-wins.
 */
export function pickBestScene(scenes: Scene[]): Scene | null {
  if (scenes.length === 0) return null;
  let best = scenes[0];
  let bestScore = -Infinity;
  for (const scene of scenes) {
    const score = selfContainmentScore(scene).score;
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

// ---------- S70 CI-3: the cold-start opener ----------
//
// The clip's first caption line, rewritten for viewers who owe the video
// nothing: name the subject, no dangling references, fit one caption flash
// (<= 34 chars). Rides the llm.ts seam through budget.ts's choke point;
// FAILS NULL (a gateway hiccup keeps the narration's own first chunk —
// the rewrite is a garnish, never a dependency). Labeled a heuristic.

const OPENER_PROMPT = `You rewrite the FIRST CAPTION LINE of a vertical Short for cold-start viewers. The clip is pulled from the middle of a longer video, so its first line may assume context the viewer does not have. Rewrite it so it: names the subject concretely (no bare pronouns), opens the loop (a question or a bold fact works), and fits one caption flash. Output STRICT JSON:

{ "line": "<=34 chars, plain text, no quotes, no emoji" }

Never wrap in markdown fences. Never add commentary.`;

export async function draftColdStartOpener(opts: {
  topic: string;
  sceneNarration: string;
}): Promise<string | null> {
  try {
    const completion = await aiCall("llm", "shorts cold-start opener", () =>
      llmChat({
        messages: [
          { role: "system", content: OPENER_PROMPT },
          {
            role: "user",
            content:
              `Video topic: ${opts.topic}\n\nScene narration:\n${opts.sceneNarration.slice(0, 900)}\n\nRewrite the first caption line. Output the STRICT JSON now.`,
          },
        ],
        temperature: 0.6,
      })
    );
    const text = completion.choices?.[0]?.message?.content ?? "";
    const parsed = parseJsonLoose(text);
    const line = typeof parsed.line === "string" ? parsed.line.replace(/["“”]/g, "'").trim() : "";
    if (!line) return null;
    return line.slice(0, 34);
  } catch {
    return null; // the garnish degrades to nothing — the Short still cuts
  }
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
  /** S70 CI-3: the cold-start opener — a rewritten first caption line for
   *  viewers who owe the video nothing (drafted by draftColdStartOpener
   *  through the LLM; null/absent = the narration's own first chunk). */
  openerOverride?: string | null;
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
  // The timeline is built from the same scenes the chosen one came from —
  // a miss is a broken invariant.
  const seg = must(
    `timeline segment for scene ${chosen.index}`,
    timeline.find((t) => t.scene.index === chosen.index),
  );

  const totalDur = await probeDuration(finalPath);
  const start = Math.min(seg.start, Math.max(0, totalDur - 1));
  const dur = Math.min(seg.duration, MAX_SHORT_SEC, totalDur - start);
  if (dur < 3)
    throw new Error("The chosen scene is too short to cut a Short from (needs 3s+)");

  // Captions: chunked narration spread across the cut. S70 CI-3: when a
  // cold-start opener was drafted, it REPLACES the first chunk — the
  // viewer's first flash names the subject instead of assuming it.
  const chunks = captionChunks(chosen.narration);
  const opener = (opts.openerOverride ?? "").trim();
  if (opener && chunks.length > 0) {
    chunks[0] = opener.slice(0, 60);
  }
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
  const fileBytes = fs.statSync(outPath).size;

  // Storage seam (T-3.7): publish artifacts (s3: upload from scratch; local:
  // in-place no-op + quota accounting). Sizes snapshotted first — the s3
  // branch consumes the scratch files.
  await storage.putFromPath(`${opts.videoId}/short.mp4`, outPath);
  if (fs.existsSync(thumbPath)) {
    await storage.putFromPath(`${opts.videoId}/short-thumb.png`, thumbPath);
  }

  return {
    durationSec: shortDur,
    fileBytes,
    sceneIndex: chosen.index,
    autoPicked,
  };
}

/** Read short.mp4 (Storage seam, T-3.7 — driver-aware). */
export async function readShortFile(videoId: string): Promise<{ buffer: Buffer; fileName: string } | null> {
  const s = await storage.stat(`${videoId}/short.mp4`);
  if (!s) return null;
  return { buffer: await storage.get(`${videoId}/short.mp4`), fileName: "short.mp4" };
}

/** Stat short.mp4 without reading it (Stage 3, T-3.6 — streaming route). */
export async function statShortFile(videoId: string): Promise<{ key: string; size: number; fileName: string } | null> {
  const key = `${videoId}/short.mp4`;
  const s = await storage.stat(key);
  if (!s) return null;
  return { key, size: s.size, fileName: "short.mp4" };
}

/** Read short-thumb.png (null when absent). */
export async function readShortThumb(videoId: string): Promise<Buffer | null> {
  const s = await storage.stat(`${videoId}/short-thumb.png`);
  if (!s) return null;
  return storage.get(`${videoId}/short-thumb.png`);
}
