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
import { imageGenerate, imageEdit, imageEditSupported } from "./providers/image";
import { aiCall } from "./budget";
import { getVideoTopicWorld, topicWorldClause, getVideoContentPolicy } from "./story";
import { videoDir } from "./ai";
import { focalFromToken } from "./motion";
import { sanitizePromptForPolicy } from "./restricted-subjects";
import { log } from "./log";
import { readPortrait } from "./characters";
import {
  getApprovedAppearanceClause,
  getApprovedWorldClause,
  getApprovedLocationRefKey,
} from "./director-plan";
import { sceneStylePrompt, type Scene } from "./types";
import { db } from "./tenant-db";
import * as storage from "./storage";

// S57/T-57.2 — the module's logger (the old [shots] prefix became a binding).
const shotsLog = log.child({ mod: "shots" });
import type { MoveKind } from "./motion";
import type { DirectorScene } from "./director-plan";
import { MOVE_SPEED_FACTOR } from "./director-plan";

// ---------------------------------------------------------------------------
// M2 — the Director→shot-engine contract (docs/director-m1-m2-spec.md §1).
//
// An APPROVED DirectorScene.shots[] becomes the authoritative shot list of the
// rendered scene: per-shot image, per-shot camera movement, per-shot duration.
// No plan / no shots → the legacy even-split fallback, bit-identical to the
// pre-M2 behavior. The Director decides WHAT; motion.ts computes HOW (the
// zoompan math); the renderer runs it.

/** CAMERA_MOVES (Director vocabulary) → MoveKind (motion.ts engine).
 *
 * S48 — the v2 vocabulary is ENGINE-VERBATIM: every v2 id maps to itself
 * ("static"→hold and "punch-in"→punch are the only renames — 1:1, no
 * creative loss). The LEGACY rows below serve pre-S48 plans and hand-built
 * fixtures only; their approximations are frozen history, never new
 * requests. Unknown values (the plan normalizer snaps everything, but be
 * defensive) → hold. */
export const CAMERA_TO_MOVE: Readonly<Record<string, MoveKind>> = {
  // --- v2 (engine-verbatim) ---
  static: "hold",
  "zoom-in": "zoom-in",
  "zoom-out": "zoom-out",
  "pan-left": "pan-left",
  "pan-right": "pan-right",
  "tilt-up": "tilt-up",
  "tilt-down": "tilt-down",
  "diag-tl": "diag-tl",
  "diag-br": "diag-br",
  "punch-in": "punch",
  // --- v1 legacy (pre-S48 plans; documented approximations) ---
  "push-in": "zoom-in",
  "pull-out": "zoom-out",
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
  /** S48 — the shot's OWN focal anchor (a motion.ts Focal) when the plan
   *  set one; absent = the scene-level heuristic (focalForScene) stays in
   *  charge, exactly as before. */
  focal?: { x: number; y: number };
  /** S48 — moveSpeed → intensity multiplier (MOVE_SPEED_FACTOR); absent =
   *  1 (the video-level motion intensity, unchanged). */
  speed?: number;
  /** S50 — the plan's hand-off into the next shot ("fade" executes as an
   *  intra-scene xfade in the shot graph; "cut"/absent = the hard cut). */
  transitionOut?: string;
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

  // Owner decision #2 (spec §4): at most EXTRAS_BUDGET fresh AI images per
  // scene — a longer shot list keeps its RHYTHM (every planned shot renders
  // with its planned move + reconciled duration) but surplus extras demote
  // to pseudo crops over the scene art instead of new generations.
  // MAX_SHOTS stays the hard ceiling on shots per scene.
  let extraBudget = EXTRAS_BUDGET;

  let handheldFlip = false; // alternate diag-tl / diag-br across handheld shots
  const available: ShotExecution[] = planShotsList.slice(0, MAX_SHOTS).map((sh) => {
    const base = CAMERA_TO_MOVE[sh.camera] ?? "hold";
    let moveKind: MoveKind = base;
    if (sh.camera === "handheld") {
      moveKind = handheldFlip ? "diag-br" : "diag-tl";
      handheldFlip = !handheldFlip;
    }
    const isScene = sh.shotIndex === 0;
    const isExtra = !isScene && extraBudget > 0;
    if (isExtra) extraBudget -= 1;
    return {
      shotIndex: sh.shotIndex,
      source: isScene ? "scene" : isExtra ? "extra" : "pseudo",
      imageFile: shotImageFile(scene.index, sh.shotIndex),
      crop: isScene || isExtra
        ? undefined
        : PSEUDO_CROPS[sh.shotIndex % PSEUDO_CROPS.length],
      moveKind,
      sec: Math.round(sh.duration * scale * 100) / 100,
      prompt: isExtra ? shotPrompt(scene, sh) : undefined,
      // S48: the Director's per-shot focal anchor + movement speed ride the
      // execution verbatim (absent = the scene heuristic / video intensity).
      focal: focalFromToken(sh.focal) ?? undefined,
      speed: MOVE_SPEED_FACTOR[sh.moveSpeed ?? "normal"] ?? 1,
      // S50: the hand-off rides too (parsePlan fills "cut" by default —
      // v1 plans and the no-plan path never fade).
      transitionOut: sh.transitionOut,
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
 *  LEADS — its first-ever consumer — then the S48 cinematic fields
 *  (subject/action, camera height, angle, depth of field, lighting, grade)
 *  and the scene's visual+mood, over the same photoreal boilerplate story.ts
 *  uses. v1-shaped shots (fields absent) render the pre-S48 prompt exactly. */
export function shotPrompt(
  scene: Scene,
  shot: {
    imagePrompt: string;
    framing: string;
    lens: string;
    composition: string;
    subject?: string;
    subjectAction?: string;
    cameraHeight?: string;
    angle?: string;
    depthOfField?: string;
    lighting?: string;
    colorGrade?: string;
  }
): string {
  const subjectClause = shot.subject
    ? `${shot.subject}${shot.subjectAction ? ` ${shot.subjectAction}` : ""}`
    : "";
  const bits = [
    scene.visual,
    shot.imagePrompt?.trim(),
    subjectClause,
    `${shot.framing} shot`,
    shot.lens && shot.lens !== "35mm" ? shot.lens : "",
    shot.composition && shot.composition !== "rule of thirds" ? shot.composition : "",
    shot.cameraHeight && shot.cameraHeight !== "eye-level" ? `${shot.cameraHeight} camera` : "",
    shot.angle && shot.angle !== "front" ? `${shot.angle} view` : "",
    shot.depthOfField && shot.depthOfField !== "deep" ? `${shot.depthOfField} depth of field` : "",
    shot.lighting,
    shot.colorGrade ? `${shot.colorGrade} color grade` : "",
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
/** Owner decision #2 (spec §4): max FRESH AI images per scene — shot 0 reuses
 *  the scene art, so a scene spends at most 3 image generations. Surplus
 *  planned shots keep their move + duration but render as pseudo crops. */
export const EXTRAS_BUDGET = 3;
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

/** S81 — compose the LOCKED extra-shot prompt. The shot's own prompt leads
 *  (the M2 law — imagePrompt first), then the same nets scene art paints
 *  under: the topic-world anchor, the per-scene art style, and the approved
 *  plan's continuity clauses (the logged outfit, the set pieces). PURE.
 *  Anchor-only composition stays BYTE-IDENTICAL to the pre-S81 path
 *  (`${base} ${anchor}.`) — locks that are absent change nothing, so an
 *  unlocked video renders exactly as before. */
export function composeLockedShotPrompt(
  basePrompt: string,
  locks: {
    anchor?: string;
    styleClause?: string;
    continuityClauses?: string[];
  }
): string {
  const anchorBit = locks.anchor ? ` ${locks.anchor}.` : "";
  const styleBit = locks.styleClause ? ` ${locks.styleClause}.` : "";
  const contBit =
    locks.continuityClauses && locks.continuityClauses.length > 0
      ? ` ${locks.continuityClauses.filter(Boolean).join(" ")}`
      : "";
  return `${basePrompt}${anchorBit}${styleBit}${contBit}`;
}

/** S81 — the likeness lead for a portrait-seeded extra shot. Mirrors the
 *  scene-art edit sentence (story.ts) with "Shot:" so the framing prompt
 *  that follows leads the edit. PURE. */
export function shotLikenessEditPrompt(shotPrompt: string): string {
  return `Place this exact person into the described shot, keeping their face, hairstyle, glasses, facial hair and signature outfit perfectly recognizable. Shot: ${shotPrompt}`;
}

/** S81 — the set-piece lead for a location-seeded extra shot, mirroring the
 *  scene-art location edit sentence. PURE. */
export function shotLocationEditPrompt(shotPrompt: string): string {
  return `Set the described shot in this exact place, keeping its architecture, layout and distinctive features recognizable. Shot: ${shotPrompt}`;
}

/** S81 — the cast-priority seed law, inherited from scene art: the host's
 *  LIKENESS outranks the set-piece reference when both exist. PURE. */
export function pickShotEditSeed(locks: {
  portrait: boolean;
  locationRef: boolean;
}): "likeness" | "location" | null {
  if (locks.portrait) return "likeness";
  if (locks.locationRef) return "location";
  return null;
}

/** S81 — the seed image an extra shot's edit is pinned to (null = no seed,
 *  fresh generation). */
interface ShotEditSeed {
  kind: "likeness" | "location";
  image: Buffer;
}

/** S81 — one fail-open read of every identity lock an extra shot must obey:
 *  the cast portrait (host scenes), the approved plan's logged outfit + set
 *  pieces, and the per-scene art style — the same locks generateSceneImage
 *  paints scene art under. Every failure = an absent lock; coverage never
 *  blocks the lane. Read once per scene, shared by every extra shot. */
async function readShotLocks(
  videoId: string,
  scene: Scene
): Promise<{
  editSeed: ShotEditSeed | null;
  styleClause: string;
  continuityClauses: string[];
}> {
  const host = scene.hostInScene;
  const [characterId, styleClause, appearanceClause, worldClause] =
    await Promise.all([
      host
        ? db
            .video
            .findUnique({
              where: { id: videoId },
              select: { characterId: true },
            })
            .then((v) => v?.characterId ?? null)
            .catch(() => null)
        : Promise.resolve(null),
      Promise.resolve(sceneStylePrompt(scene.style)),
      host
        ? getApprovedAppearanceClause(videoId, scene.index).catch(() => "")
        : Promise.resolve(""),
      getApprovedWorldClause(videoId, scene.index).catch(() => ""),
    ]);
  const portrait = characterId
    ? await readPortrait(characterId).catch(() => null)
    : null;
  // Cast likeness > set-piece likeness (the scene-art priority law): a host
  // scene with a portrait never spends its single edit seed on the backdrop.
  let editSeed: ShotEditSeed | null = null;
  if (portrait) {
    editSeed = { kind: "likeness", image: portrait };
  } else {
    const refKey = await getApprovedLocationRefKey(videoId, scene.index).catch(
      () => null
    );
    const ref = refKey
      ? await storage.get(refKey).catch(() => null)
      : null;
    if (ref) editSeed = { kind: "location", image: ref };
  }
  return {
    editSeed,
    styleClause,
    continuityClauses: [appearanceClause, worldClause].filter(Boolean),
  };
}

/** Generate every missing EXTRA shot image for a scene (M2 contract: the
 *  executions carry their own prompts — imagePrompt leads). Shots whose
 *  generation fails are DEMOTED to pseudo (crop over the scene image) in the
 *  returned plan, so the render always has a full shot list. Returns the
 *  updated plan — the caller never mutates. S49: under a restricted content
 *  policy the composed prompt is sanitized (restricted-figure sentences →
 *  alternative compositions + the hard negative clause rides along).
 *  S81 (shot-art lock coverage): extra shots paint under the same identity
 *  locks as scene art — the continuity clauses join the composed prompt and
 *  host/set-piece edits seed the likeness. Every lock failure falls through
 *  to the unlocked path; an absent plan or portrait changes nothing. */
export async function ensureShotImages(opts: {
  videoId: string;
  scene: Scene;
  plan: SceneShotPlan;
}): Promise<SceneShotPlan> {
  const dir = videoDir(opts.videoId);
  // S31 — the topic-world anchor for extra shots: the same net the scene
  // art paints under (story.ts). Read once per scene; an absent world means
  // the shot prompt passes through untouched.
  const anchor = topicWorldClause(await getVideoTopicWorld(opts.videoId));
  // S49 (L3) — the content policy for this video, read once per scene.
  const contentPolicy = await getVideoContentPolicy(opts.videoId);
  // S81 — the identity locks, read once per scene (fail-open: every read
  // failure = an absent lock, never a blocked lane).
  const locks = await readShotLocks(opts.videoId, opts.scene);
  const seed = locks.editSeed;
  // Edit-capable providers seed the likeness; text-to-image providers keep
  // the fresh-generation path (the seed is prompt-side only for them).
  const canEdit = seed ? await imageEditSupported() : false;
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
    // Compose, then sanitize under the policy (standard = identity + no
    // negative clause — byte-identical to the pre-S49 prompt). S81: the
    // locks' clauses ride after the anchor; anchor-only stays byte-identical
    // to the pre-S81 composition.
    const composed = composeLockedShotPrompt(shot.prompt, {
      anchor: anchor || undefined,
      styleClause: locks.styleClause || undefined,
      continuityClauses: locks.continuityClauses,
    });
    const sanitized = sanitizePromptForPolicy(composed, contentPolicy);
    if (sanitized.substituted > 0) {
      shotsLog.warn(
        "content policy substituted sentence(s) naming restricted subject(s)",
        { scene: opts.scene.index, shot: shot.shotIndex, substituted: sanitized.substituted, matches: sanitized.matches.map((m) => m.entry) }
      );
    }
    try {
      let buffer: Buffer | null = null;
      if (seed && canEdit) {
        // S81 — identity-locked extra shot: seed the edit with the cast
        // portrait (host likeness) or the location reference (set piece),
        // the same ladder scene art uses. Real failures fall through to the
        // fresh generation below — the shot never blocks on its lock.
        buffer = await aiCall(
          "image",
          `scene ${opts.scene.index} shot ${shot.shotIndex} edit (${
            seed.kind === "likeness" ? "host likeness" : "location seed"
          })`,
          () =>
            imageEdit({
              prompt:
                seed.kind === "likeness"
                  ? shotLikenessEditPrompt(sanitized.prompt)
                  : shotLocationEditPrompt(sanitized.prompt),
              imagePngBase64: seed.image.toString("base64"),
              size: "1344x768",
            }).then((b) => {
              if (!b) throw new Error("Image edit returned no data");
              return b;
            }),
          { attempts: 2, baseDelayMs: 4000 }
        ).catch(() => null);
      }
      if (!buffer) {
        buffer = await aiCall(
          "image",
          `scene ${opts.scene.index} shot ${shot.shotIndex}`,
          () =>
            imageGenerate({
              prompt: sanitized.prompt,
              size: "1344x768",
            }),
          { attempts: 2, baseDelayMs: 4000 }
        );
      }
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
