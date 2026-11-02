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
import type { MoveKind } from "./motion";
import type { DirectorScene } from "./director-plan";

// ---------------------------------------------------------------------------
// M2 — the Director→shot-engine contract (docs/director-m1-m2-spec.md §1).
//
// An APPROVED DirectorScene.shots[] becomes the authoritative shot list of the
// rendered scene: per-shot image, per-shot camera movement, per-shot duration.
// No plan / no shots → the legacy even-split fallback, bit-identical to the
// pre-M2 behavior. The Director decides WHAT; motion.ts computes HOW (the
// zoompan math); the renderer runs it.

/** CAMERA_MOVES (Director vocabulary) → MoveKind (motion.ts engine).
 *  Approximations are documented per entry — Ken Burns cannot shake or crane,
 *  so the mapping picks the closest supported movement. Unknown values (the
 *  plan normalizer snaps everything, but be defensive) → hold. */
export const CAMERA_TO_MOVE: Readonly<Record<string, MoveKind>> = {
  static: "hold",
  "push-in": "zoom-in",
  "pull-out": "zoom-out",
  "pan-left": "pan-left",
  "pan-right": "pan-right",
  "tilt-up": "tilt-up",
  "tilt-down": "tilt-down",
  // dolly-in: a track-in reads as a slow, larger-scale zoom on a still.
  "dolly-in": "zoom-in",
  // handheld: alternating diagonal drifts — the closest Ken Burns has to
  // organic instability.
  handheld: "diag-tl",
  // crane-up: vertical rise → tilt-up (scale nuance lost, direction kept).
  "crane-up": "tilt-up",
  // drone: aerial pull-back reveal → diagonal drift.
  drone: "diag-br",
};

/** The execution-time projection of one DirectorShot — what the renderer
 *  actually runs. Built ONLY from an approved plan + the measured narration. */
export interface ShotExecution {
  shotIndex: number; // from DirectorShot (0 = the scene's own image)
  source: "scene" | "extra" | "pseudo";
  //  scene  = shot 0, the existing scene image (the director addendum and
  //           continuity clauses are already woven into its prompt)
  //  extra  = AI-generated image from THIS shot's plan fields
  //  pseudo = crop window over the scene image (fallback when generation
  //           fails — the picture still changes on schedule)
  imageFile: string; // file NAME inside the video dir (shotImageFile)
  crop?: { w: number; h: number; x: number; y: number }; // pseudo only
  moveKind: MoveKind; // motion.ts executes this
  sec: number; // reconciled duration
  prompt?: string; // extra only — the generation prompt (imagePrompt leads)
}

/** All shots of one scene, ordered; durations sum ≈ the scene duration. */
export interface SceneShotPlan {
  sceneIndex: number;
  available: ShotExecution[];
}

/**
 * Build the shot plan for one scene from an approved DirectorScene (or the
 * legacy fallback when there is none). PURE — no fs, no DB, no AI calls;
 * unit-testable in isolation.
 *
 * Duration reconciliation (spec §1.4 — inherits the Battle Yamuk rule):
 *  - sum(planned) < measured  → scale-to-fit: planned durations stretch
 *    proportionally to fill the measured narration exactly (the Director's
 *    RELATIVE rhythm is preserved, the scene never cuts words short).
 *  - sum(planned) ≥ measured  → planned durations pass through unchanged
 *    (extend-only: a plan may hold a scene longer than its narration share,
 *    never shorten it — timeline.ts's rule, inherited at shot level).
 */
export function buildSceneShots(input: {
  scene: Scene;
  planScene: DirectorScene | null;
  measuredSec: number;
}): SceneShotPlan {
  const { scene, planScene, measuredSec } = input;
  const dur = Number.isFinite(measuredSec) && measuredSec > 0 ? measuredSec : 1.5;

  const planShotsList = planScene?.shots ?? [];
  if (planShotsList.length === 0) {
    // No plan → legacy even split over the scene image (bit-identical to the
    // pre-M2 path: planShots + rotation cameras + pseudo crops).
    const split = planShots(dur);
    return {
      sceneIndex: scene.index,
      available: split.durations.map((sec, i) => ({
        shotIndex: i,
        source: i === 0 ? ("scene" as const) : ("pseudo" as const),
        imageFile: i === 0 ? shotImageFile(scene.index, 0) : shotImageFile(scene.index, i),
        crop: i > 0 ? PSEUDO_CROPS[i % PSEUDO_CROPS.length] : undefined,
        moveKind: i === 0 ? "zoom-in" : (SHOT_CAMERA_MOVEKINDS[i % SHOT_CAMERA_MOVEKINDS.length] as MoveKind),
        sec,
      })),
    };
  }

  // Planned path — reconcile durations.
  const plannedTotal = planShotsList.reduce((acc, sh) => acc + sh.duration, 0);
  const scale = plannedTotal > 0 && plannedTotal < dur ? dur / plannedTotal : 1;

  let handheldFlip = false; // alternate diag-tl / diag-br across handheld shots
  const available: ShotExecution[] = planShotsList.map((sh) => {
    const base = CAMERA_TO_MOVE[sh.camera] ?? "hold";
    let moveKind: MoveKind = base;
    if (sh.camera === "handheld") {
      moveKind = handheldFlip ? "diag-br" : "diag-tl";
      handheldFlip = !handheldFlip;
    }
    const isScene = sh.shotIndex === 0;
    return {
      shotIndex: sh.shotIndex,
      source: isScene ? "scene" : "extra",
      imageFile: shotImageFile(scene.index, sh.shotIndex),
      moveKind,
      sec: Math.round(sh.duration * scale * 100) / 100,
      prompt: isScene ? undefined : shotPrompt(scene, sh),
    };
  });

  return { sceneIndex: scene.index, available };
}

/** Rotation cameras for the no-plan path — the legacy SHOT_CAMERAS ids
 *  mapped into MoveKinds (zoom-out → "zoom-out", etc.). */
const SHOT_CAMERA_MOVEKINDS: readonly MoveKind[] = [
  "zoom-in", // SHOT_CAMERAS[0] — but shot 0 uses a plain zoom-in (see above)
  "pan-right",
  "zoom-out",
  "pan-left",
  "zoom-in",
];

/** Prompt for an extra shot image (spec §1.6): the shot's own imagePrompt
 *  LEADS — its first-ever consumer — then framing/lens/composition and the
 *  scene's visual+mood, over the same photoreal boilerplate story.ts uses. */
export function shotPrompt(
  scene: Scene,
  shot: { imagePrompt: string; framing: string; lens: string; composition: string }
): string {
  const bits = [
    scene.visual,
    shot.imagePrompt?.trim(),
    `${shot.framing} shot`,
    shot.lens && shot.lens !== "35mm" ? shot.lens : "",
    shot.composition && shot.composition !== "rule of thirds" ? shot.composition : "",
    scene.mood,
  ].filter(Boolean);
  return (
    bits.join(". ") +
    ". Wide 16:9 cinematic frame, ultra-realistic photograph shot on a full-frame cinema camera, " +
    "natural depth of field, physically accurate lighting for the time of day, lifelike skin, fabric " +
    "and material textures, documentary realism, ONE dominant subject filling the frame, professional " +
    "cinematic color grading. Absolutely no text, no letters, no numbers, no charts, no watermarks."
  );
}

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

export interface ShotPlan {
  /** Number of shots the scene is cut into (>= 1). */
  count: number;
  /** Exact duration of each shot; sums to the scene duration. */
  durations: number[];
  /** True when extra AI images are needed (vs pseudo-shots over one image). */
  needsImages: boolean;
}

/** Plan how a scene of `dur` seconds is subdivided (the no-plan fallback:
 *  durations only — the move per shot comes from SHOT_CAMERA_MOVEKINDS in
 *  buildSceneShots). */
export function planShots(dur: number): ShotPlan {
  if (dur <= SHOT_MAX_SEC) {
    return { count: 1, durations: [dur], needsImages: false };
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
        needsImages: fewer > 1,
      };
    }
  }
  return {
    count,
    durations: Array.from({ length: count }, () => base),
    needsImages: count > 1,
  };
}

/** File name of shot k (0-based) for scene index (1-based). k=0 → scene image. */
export function shotImageFile(sceneIndex: number, shot: number): string {
  return shot === 0
    ? `scene-${String(sceneIndex).padStart(2, "0")}.png`
    : `shot-${String(sceneIndex).padStart(2, "0")}-${shot}.png`;
}

/** Generate every missing EXTRA shot image for a scene (M2 contract: the
 *  executions carry their own prompts — imagePrompt leads). Shots whose
 *  generation fails are DEMOTED to pseudo (crop over the scene image) in the
 *  returned plan, so the render always has a full shot list. Returns the
 *  updated plan — the caller never mutates. */
export async function ensureShotImages(opts: {
  videoId: string;
  scene: Scene;
  plan: SceneShotPlan;
}): Promise<SceneShotPlan> {
  const dir = videoDir(opts.videoId);
  const available: ShotExecution[] = [];
  for (const shot of opts.plan.available) {
    if (shot.source !== "extra" || !shot.prompt) {
      available.push(shot);
      continue;
    }
    const file = path.join(dir, shot.imageFile);
    if (fs.existsSync(file) && fs.statSync(file).size > 10_000) {
      available.push(shot); // already generated (re-render / resume)
      continue;
    }
    try {
      const buffer = await aiCall(
        "image",
        `scene ${opts.scene.index} shot ${shot.shotIndex}`,
        () => imageGenerate({ prompt: shot.prompt!, size: "1344x768" }),
        { attempts: 2, baseDelayMs: 4000 }
      );
      if (buffer && buffer.length > 10_000) {
        fs.writeFileSync(file, buffer);
        available.push(shot);
        continue;
      }
      throw new Error("empty image buffer");
    } catch {
      // Generation failed → pseudo-shot fallback: crop window over the
      // scene's own image with the planned move. The picture still changes.
      available.push({
        ...shot,
        source: "pseudo",
        imageFile: shotImageFile(opts.scene.index, 0),
        crop: PSEUDO_CROPS[shot.shotIndex % PSEUDO_CROPS.length],
        prompt: undefined,
      });
    }
  }
  return { sceneIndex: opts.plan.sceneIndex, available };
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
