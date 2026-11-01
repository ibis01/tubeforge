// Stage 5 — the AI Director PLAN layer: types, vocabularies, parse/normalize
// and the render-side accessor. Split from director.ts so the render pipeline
// (story.ts) can steer image prompts WITHOUT importing the LLM pass — that
// would be an import cycle (story → director → story). Pure module: no
// story.ts / llm.ts imports.

import { db } from "./tenant-db";
import { TRANSITIONS } from "./transitions";

// ---------------------------------------------------------------------------
// Vocabularies — the LLM picks from these; the normalizer snaps to them.

export const FRAMINGS = [
  "wide",
  "medium",
  "close-up",
  "extreme close-up",
  "over-the-shoulder",
  "pov",
  "aerial",
] as const;

export const CAMERA_MOVES = [
  "static",
  "push-in",
  "pull-out",
  "pan-left",
  "pan-right",
  "tilt-up",
  "tilt-down",
  "dolly-in",
  "handheld",
  "crane-up",
  "drone",
] as const;

export const COMPOSITIONS = [
  "rule of thirds",
  "leading lines",
  "golden ratio",
  "centered symmetry",
  "negative space",
  "frame within frame",
  "diagonal",
] as const;

const TRANSITION_IDS = TRANSITIONS.map((t) => t.id);
const MOTION_IDS = ["smart", "zoom", "pan", "off"] as const;

/** A single shot inside a scene — the unit the render pipeline cuts between. */
export interface DirectorShot {
  shotIndex: number; // 0-based within the scene
  framing: string; // FRAMINGS
  camera: string; // CAMERA_MOVES
  lens: string; // free text: "24mm wide", "85mm f/1.8 shallow depth of field"
  composition: string; // COMPOSITIONS
  duration: number; // seconds — shots of one scene sum to ≈ the scene length
  imagePrompt: string; // shot-specific visual addendum (what THIS shot shows)
}

/** One scene's direction. */
export interface DirectorScene {
  sceneIndex: number; // 1-based — matches Scene.index
  mood: string; // visual mood: palette + lighting + time-of-day keywords
  transitionIn: string; // transitions.ts id ("" for scene 1 — nothing to blend from)
  motion: string; // motion.ts override hint: smart | zoom | pan | off
  needsI2V: boolean; // animated render mode: does THIS scene merit image-to-video
  useStock: boolean; // real-world / documentary scenes that should use stock b-roll
  outfit?: string; // cast look for the scene (persisted to CharacterAppearance)
  accessory?: string;
  shots: DirectorShot[];
}

/** The full plan — versioned so old persisted plans stay parseable. */
export interface DirectorPlan {
  version: 1;
  generatedAt: string; // ISO timestamp
  concept: string; // one-paragraph directorial concept (the "why")
  scenes: DirectorScene[];
}

export type DirectorState = "proposed" | "approved" | "dismissed";

// ---------------------------------------------------------------------------
// Parse + normalize — the LLM's JSON is a suggestion; this is the contract.

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v.trim() : fallback;
}

function snap(v: unknown, allowed: readonly string[], fallback: string): string {
  const s = asString(v).toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

/** Parse + normalize a persisted or freshly-generated plan. Returns null when
 *  there is nothing usable (null/empty/corrupt JSON degrades to null — a
 *  broken plan must never wedge the pipeline, mirroring Job.payload policy). */
export function parsePlan(json: string | null | undefined): DirectorPlan | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const scenesIn = Array.isArray(obj.scenes) ? obj.scenes : [];
  const scenes: DirectorScene[] = [];
  for (const s of scenesIn) {
    if (!s || typeof s !== "object") continue;
    const so = s as Record<string, unknown>;
    const sceneIndex = Math.round(clamp(so.sceneIndex, 1, 999, NaN));
    if (!Number.isFinite(sceneIndex)) continue;
    const shotsIn = Array.isArray(so.shots) ? so.shots : [];
    const shots: DirectorShot[] = [];
    for (const sh of shotsIn) {
      if (!sh || typeof sh !== "object") continue;
      const sho = sh as Record<string, unknown>;
      const duration = clamp(sho.duration, 0.5, 10, 2.5);
      shots.push({
        shotIndex: Math.max(0, Math.round(clamp(sho.shotIndex, 0, 99, shots.length))),
        framing: snap(sho.framing, FRAMINGS, "medium"),
        camera: snap(sho.camera, CAMERA_MOVES, "static"),
        lens: asString(sho.lens, "35mm").slice(0, 120),
        composition: snap(sho.composition, COMPOSITIONS, "rule of thirds"),
        duration,
        imagePrompt: asString(sho.imagePrompt).slice(0, 400),
      });
    }
    scenes.push({
      sceneIndex,
      mood: asString(so.mood).slice(0, 200),
      // Scene 1 has nothing to blend from — force "" there.
      transitionIn: sceneIndex <= 1 ? "" : snap(so.transitionIn, TRANSITION_IDS, "fade"),
      motion: snap(so.motion, MOTION_IDS, "smart"),
      needsI2V: so.needsI2V === true,
      useStock: so.useStock === true,
      outfit: asString(so.outfit).slice(0, 160) || undefined,
      accessory: asString(so.accessory).slice(0, 160) || undefined,
      shots: shots.sort((a, b) => a.shotIndex - b.shotIndex),
    });
  }
  scenes.sort((a, b) => a.sceneIndex - b.sceneIndex);
  // An empty plan is NO plan — "nothing usable" degrades to null so callers
  // can treat absent / corrupt / scene-less identically (the pass itself
  // throws a readable error before persisting an empty plan).
  if (scenes.length === 0) return null;
  return {
    version: 1,
    generatedAt: asString(obj.generatedAt) || new Date().toISOString(),
    concept: asString(obj.concept).slice(0, 600),
    scenes,
  };
}

export function serializePlan(plan: DirectorPlan): string {
  return JSON.stringify(plan);
}

/** Total planned seconds for one scene (0 when the plan has no entry). */
export function planSceneDuration(plan: DirectorPlan | null, sceneIndex: number): number {
  const s = plan?.scenes.find((x) => x.sceneIndex === sceneIndex);
  if (!s) return 0;
  return s.shots.reduce((acc, sh) => acc + sh.duration, 0);
}

/**
 * Image-prompt addendum for a scene under a plan — framing, lens, composition
 * and the plan's visual mood woven into the scene's own prompt. Missing plan
 * → "" (the pipeline renders exactly as before).
 */
export function directorImageAddendum(plan: DirectorPlan | null, sceneIndex: number): string {
  if (!plan) return "";
  const s = plan.scenes.find((x) => x.sceneIndex === sceneIndex);
  if (!s) return "";
  const first = s.shots[0];
  const parts: string[] = [];
  if (first) {
    parts.push(`${first.framing} shot`);
    if (first.lens && first.lens !== "35mm") parts.push(first.lens);
    if (first.composition && first.composition !== "rule of thirds") parts.push(first.composition);
  }
  if (s.mood) parts.push(s.mood);
  return parts.length ? parts.join(", ") : "";
}

/** Per-scene transition id under a plan ("" when none / no entry). */
export function planTransitionIn(plan: DirectorPlan | null, sceneIndex: number): string {
  return plan?.scenes.find((x) => x.sceneIndex === sceneIndex)?.transitionIn ?? "";
}

// ---------------------------------------------------------------------------
// Pacing gate (Stage 5 completion gate) — "the video has a deliberate
// cinematic rhythm": 3+ consecutive shots the director pointed at the screen
// WITHOUT giving them motion is flat pacing, no matter how good the stills are.

/** A run of consecutive unmotivated-static shots, in story order. */
export interface PlanStaticRun {
  length: number; // shots in the run
  fromScene: number; // 1-based scene index of the first shot
  toScene: number; // 1-based scene index of the last shot
}

/** Mode-level exemptions the caller knows from the render mode: an "animated"
 * (i2v) or "stock" render moves every scene regardless of the plan flags. */
export interface PacingExemptions {
  i2vEverywhere?: boolean;
  stockEverywhere?: boolean;
}

function isUnmotivatedStaticShot(
  scene: DirectorScene,
  shot: DirectorShot,
  ex: PacingExemptions
): boolean {
  if (shot.camera !== "static") return false;
  if (ex.i2vEverywhere || ex.stockEverywhere) return false;
  // Motivation channels: Ken Burns motion, image-to-video, real stock footage.
  return scene.motion === "off" && !scene.needsI2V && !scene.useStock;
}

/**
 * Runs of consecutive unmotivated-static shots (longest first). A scene the
 * plan skips or gives no shots breaks a run — its pacing is unknown, so it
 * can neither extend nor excuse the flat stretch beside it.
 */
export function planStaticRuns(
  plan: DirectorPlan | null,
  ex: PacingExemptions = {}
): PlanStaticRun[] {
  if (!plan) return [];
  const runs: PlanStaticRun[] = [];
  let length = 0;
  let fromScene = 0;
  let toScene = 0;
  const flush = () => {
    if (length > 0) runs.push({ length, fromScene, toScene });
    length = 0;
  };
  let prevIndex: number | null = null;
  for (const scene of plan.scenes) {
    if (prevIndex !== null && scene.sceneIndex !== prevIndex + 1) flush(); // index gap
    if (scene.shots.length === 0) {
      flush(); // shot-less scene = unknown pacing
    } else {
      for (const shot of scene.shots) {
        if (isUnmotivatedStaticShot(scene, shot, ex)) {
          if (length === 0) fromScene = scene.sceneIndex;
          length += 1;
          toScene = scene.sceneIndex;
        } else {
          flush();
        }
      }
    }
    prevIndex = scene.sceneIndex;
  }
  flush();
  return runs.sort((a, b) => b.length - a.length);
}

/**
 * Render-side accessor — the addendum for one scene when (and ONLY when) the
 * human has APPROVED the plan. Unapproved plans never touch the pipeline.
 * One small read per scene image; image generation dwarfs it.
 */
export async function getApprovedAddendum(videoId: string, sceneIndex: number): Promise<string> {
  const video = await db.video.findUnique({
    where: { id: videoId },
    select: { shotList: true, directorState: true },
  });
  if (!video || video.directorState !== "approved") return "";
  return directorImageAddendum(parsePlan(video.shotList), sceneIndex);
}

/**
 * Render-side accessor (module D) — per-scene motion overrides from an
 * APPROVED plan: the director picks the movement channel per scene, on top of
 * the video-level motion setting. "smart" (the default) means "defer to the
 * video-level mode", so it never appears in the map. Empty map = no approved
 * plan / no overrides — the render is exactly as before.
 */
export async function getApprovedMotionMap(
  videoId: string
): Promise<Map<number, "zoom" | "pan" | "off">> {
  const video = await db.video.findUnique({
    where: { id: videoId },
    select: { shotList: true, directorState: true },
  });
  const map = new Map<number, "zoom" | "pan" | "off">();
  if (!video || video.directorState !== "approved") return map;
  const plan = parsePlan(video.shotList);
  if (!plan) return map;
  for (const scene of plan.scenes) {
    if (scene.motion === "zoom" || scene.motion === "pan" || scene.motion === "off") {
      map.set(scene.sceneIndex, scene.motion);
    }
  }
  return map;
}
