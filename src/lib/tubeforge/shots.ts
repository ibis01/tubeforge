// Shot planning — kills the #1 retention killer from the external review:
// "why do you have one image that long.. Always change image, effect, or
// anything within max 3 secs".
//
// Every scene is subdivided into SHOTS of ≤ SHOT_MAX_SEC seconds. Each shot
// gets its own image (a fresh AI render of a different angle/framing of the
// scene) and its own camera move, cut together inside the scene segment.
// When a shot image can't be generated (offline, quota, failure) we fall
// back to PSEUDO-shots: distinct crop windows + camera moves over the scene's
// existing art, so the picture still changes on schedule.
import fs from "fs";
import path from "path";
import { imageGenerate } from "./providers/image";
import { aiCall } from "./budget";
import { videoDir } from "./ai";
import type { Scene } from "./types";

/** Longest any single shot may run — the reviewer's demand verbatim:
 *  "Always change image, effect, or anything within max 3 secs". */
export const SHOT_MAX_SEC = 3.0;
/** Shortest sensible shot — below this it feels like a slideshow flicker. */
export const SHOT_MIN_SEC = 2.0;
/** Hard cap on shots per scene. 7 × 3s covers every realistic scene length
 *  (typical narration scenes run 8–18s); beyond it we split evenly anyway. */
export const MAX_SHOTS = 7;
/** Fewer shots than this = the scene is one image (too-short scenes). */
export const MIN_SHOTS = 1;

/** Shot framings, rotated per index. Shot 0 is the existing scene art. */
const SHOT_FRAMINGS = [
  null, // shot 0 — the original scene image
  "extreme close-up on the single most important detail, face or object fills the frame, shallow depth of field",
  "dramatic low-angle view from a different vantage point, subject seen from below, imposing scale",
  "wide environment shot emphasizing the setting and scale, subject small against the world",
  "over-the-shoulder reverse angle revealing what the subject is looking at",
  "top-down or high-angle overview of the whole scene, graphic composition",
];

/** Camera moves rotated per shot so consecutive shots never repeat. */
const SHOT_CAMERAS = ["push-in", "pan-right", "zoom-out", "pan-left", "zoom-in"];

export interface ShotPlan {
  /** Number of shots the scene is cut into (>= 1). */
  count: number;
  /** Exact duration of each shot; sums to the scene duration. */
  durations: number[];
  /** Camera id per shot. */
  cameras: string[];
  /** True when extra AI images are needed (vs pseudo-shots over one image). */
  needsImages: boolean;
}

/** Plan how a scene of `dur` seconds is subdivided. */
export function planShots(dur: number): ShotPlan {
  if (dur <= SHOT_MAX_SEC) {
    return { count: 1, durations: [dur], cameras: ["zoom-in"], needsImages: false };
  }
  // Target the ceiling: as many shots as fit within SHOT_MAX_SEC, capped.
  const count = Math.max(
    MIN_SHOTS,
    Math.min(MAX_SHOTS, Math.ceil(dur / SHOT_MAX_SEC))
  );
  const base = dur / count;
  // If the even split dips below the floor, reduce shot count.
  if (base < SHOT_MIN_SEC && count > 1) {
    const fewer = count - 1;
    const b2 = dur / fewer;
    if (b2 >= SHOT_MIN_SEC) {
      return {
        count: fewer,
        durations: Array.from({ length: fewer }, () => b2),
        cameras: shotCameras(fewer),
        needsImages: fewer > 1,
      };
    }
  }
  return {
    count,
    durations: Array.from({ length: count }, () => base),
    cameras: shotCameras(count),
    needsImages: count > 1,
  };
}

function shotCameras(count: number): string[] {
  return Array.from({ length: count }, (_, i) => SHOT_CAMERAS[i % SHOT_CAMERAS.length]);
}

/** File name of shot k (0-based) for scene index (1-based). k=0 → scene image. */
export function shotImageFile(sceneIndex: number, shot: number): string {
  return shot === 0
    ? `scene-${String(sceneIndex).padStart(2, "0")}.png`
    : `shot-${String(sceneIndex).padStart(2, "0")}-${shot}.png`;
}

/** Generate every missing extra shot image for a scene. Returns how many
 *  real extra images exist afterwards (0 = pseudo-shot fallback). */
export async function ensureShotImages(opts: {
  videoId: string;
  scene: Scene;
  count: number;
}): Promise<number> {
  const dir = videoDir(opts.videoId);
  let available = 1; // shot 0 = the scene image itself
  for (let k = 1; k < opts.count; k++) {
    const file = path.join(dir, shotImageFile(opts.scene.index, k));
    if (fs.existsSync(file) && fs.statSync(file).size > 10_000) {
      available++;
      continue;
    }
    const framing = SHOT_FRAMINGS[k % SHOT_FRAMINGS.length] ?? SHOT_FRAMINGS[1];
    const prompt =
      `${opts.scene.visual}. ${framing}. ${opts.scene.mood}. ` +
      "Wide 16:9 cinematic frame, highly detailed, professional color grading. " +
      "Absolutely no text, no letters, no watermarks.";
    try {
      const buffer = await aiCall(
        "image",
        `scene ${opts.scene.index} shot ${k}`,
        () => imageGenerate({ prompt, size: "1344x768" }),
        { attempts: 2, baseDelayMs: 4000 }
      );
      if (buffer && buffer.length > 10_000) {
        fs.writeFileSync(file, buffer);
        available++;
      }
    } catch {
      // Shot generation failed — leave the file missing; the renderer will
      // fall back to pseudo-shots (crop windows) over what exists.
      break;
    }
  }
  return available;
}

/**
 * Distinct crop windows for pseudo-shots over a single image — keeps the
 * picture changing even when AI image generation is unavailable. Each entry
 * is a crop rectangle in source pixels applied AFTER the 3840x2160 upscale
 * and BEFORE zoompan, so every shot frames a genuinely different region.
 * ORDERED so consecutive shots overlap as little as possible (full → tight
 * detail → opposite half → far quadrant → low band …) — weak overlaps read
 * as "the same image" and are exactly what the review called out.
 */
export const PSEUDO_CROPS: { w: number; h: number; x: number; y: number }[] = [
  { w: 3840, h: 2160, x: 0, y: 0 }, // full frame
  { w: 2200, h: 1238, x: 820, y: 461 }, // tight center (detail, big scale jump)
  { w: 1920, h: 2160, x: 1920, y: 0 }, // right half, full height
  { w: 1920, h: 1080, x: 0, y: 0 }, // top-left quadrant (no overlap w/ right half)
  { w: 2700, h: 1521, x: 570, y: 639 }, // low wide band (bottom-center)
  { w: 1920, h: 2160, x: 0, y: 0 }, // left half, full height
  { w: 1920, h: 1080, x: 1920, y: 0 }, // top-right quadrant (no overlap w/ left half)
  { w: 1920, h: 1080, x: 0, y: 1080 }, // bottom-left quadrant
];
