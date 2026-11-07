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

// S48 — CAMERA_MOVES v2: ENGINE-VERBATIM. Every id is (a 1:1 rename of) a
// motion.ts MoveKind, so a v2 plan's camera verb executes EXACTLY — the
// pre-S48 split-brain (dolly-in silently rendered as a zoom, crane-up as a
// tilt, drone as a drift) is over for new plans. Cinematic language Ken
// Burns cannot honor (crane, drone, dolly, handheld, tracking) lives in the
// PROMPT fields (lens/cameraHeight/angle/subjectAction/imagePrompt) that
// steer the image models — and in the i2v prompt, which can honor it.
//   static   → hold (rename)   punch-in → punch (rename)
//   every other id → the identical motion.ts MoveKind.
export const CAMERA_MOVES = [
  "static",
  "zoom-in",
  "zoom-out",
  "pan-left",
  "pan-right",
  "tilt-up",
  "tilt-down",
  "diag-tl",
  "diag-br",
  "punch-in",
] as const;

/** Pre-S48 plans carry these verbs. parsePlan still accepts them (snapped
 * here, mapped to engine kinds by shots.ts CAMERA_TO_MOVE at execution) so
 * every persisted v1 plan renders byte-identically — the old approximations
 * are frozen history for legacy plans, never new requests. */
export const LEGACY_CAMERA_MOVES = [
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

const CAMERA_ALL = [...CAMERA_MOVES, ...LEGACY_CAMERA_MOVES] as readonly string[];

// S48 v2 shot vocabularies (the 19-field cinematic schema, fields 10–18).
export const CAMERA_HEIGHTS = [
  "eye-level",
  "low-angle",
  "high-angle",
  "overhead",
  "ground-level",
] as const;

export const ANGLES = ["front", "three-quarter", "profile", "back"] as const;

export const DEPTHS_OF_FIELD = ["deep", "shallow", "rack"] as const;

/** Per-shot Ken Burns speed — a multiplier on the motion intensity. */
export const MOVE_SPEEDS = ["slow", "normal", "fast"] as const;

/** moveSpeed → intensity multiplier (motion.ts shotIntensity). */
export const MOVE_SPEED_FACTOR: Record<string, number> = {
  slow: 0.7,
  normal: 1,
  fast: 1.35,
};

/** Shot hand-off vocabulary. "cut" executes today; "fade" lands with the
 * S50 per-shot xfade — the one deliberately deferred v2 field, defaulted to
 * "cut" so nothing waits on it. */
export const SHOT_TRANSITIONS = ["cut", "fade"] as const;

/** The narrative function of a shot (approval-card badge; S53 QC hooks). */
export const SHOT_PURPOSES = [
  "establish",
  "contextualize",
  "detail",
  "reaction",
  "reveal",
  "payoff",
] as const;

/** Per-shot focal anchors — the SAME tokens motion.ts resolves (its
 * normalizeFocalToken is the canonical normalizer; this list is what the
 * Director may write and what parsePlan snaps against). */
export const FOCAL_ANCHORS = [
  "center",
  "left",
  "right",
  "upper",
  "lower",
  "upper-left",
  "upper-right",
  "lower-left",
  "lower-right",
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

// Milestone 1 — production profile ids. The low-level layer keeps the id
// list so `parsePlan` can snap an unknown profile → undefined (legacy plan
// byte-identical) WITHOUT importing the profile catalog (a higher layer).
// The catalog (production-profiles.ts) imports this list and asserts every
// id has a profile — the tests pin the contract both ways.
export const PROFILE_IDS = [
  "narrative",
  "documentary",
  "explainer",
  "advertisement",
  "animation",
  "podcast",
  "social",
] as const;

// Module E — audio direction vocabularies. pacing modulates the narration
// speed per scene; ambience picks a synthesized ambient bed; sfx suggests the
// scene-boundary cue (same catalog as sfx.ts).
export const PACINGS = ["slow", "normal", "fast"] as const;
export const AMBIENCE_KINDS = [
  "none",
  "room",
  "city",
  "nature",
  "rain",
  "crowd",
  "wind",
  "waves",
] as const;
export const SFX_HINTS = ["none", "whoosh", "boom", "riser", "sting"] as const;

/** Narration speed multiplier per pacing hint (module E voice timing). */
export function pacingSpeedFactor(pacing: string): number {
  if (pacing === "slow") return 0.88;
  if (pacing === "fast") return 1.12;
  return 1;
}

/** A single shot inside a scene — the unit the render pipeline cuts between.
 *
 * S48 — the 19-field cinematic shot. Fields 1–7 are the v1 schema (present on
 * every plan since Stage 5); fields 8–19 are v2. They are OPTIONAL on the
 * interface because v1 plans, hand-built test fixtures and human edits may
 * predate them — but parsePlan ALWAYS fills them with the documented
 * defaults, so every PARSED plan (the only kind the pipeline consumes)
 * carries the complete 19-field shape. The LLM-facing JSON schema demands
 * all 19; the parser tolerates absence (fail-open to the v1 behavior). */
export interface DirectorShot {
  shotIndex: number; // 0-based within the scene
  framing: string; // FRAMINGS
  camera: string; // CAMERA_MOVES (v2, engine-verbatim) or a LEGACY_CAMERA_MOVES verb on pre-S48 plans
  lens: string; // free text: "24mm wide", "85mm f/1.8 shallow depth of field"
  composition: string; // COMPOSITIONS
  duration: number; // seconds — shots of one scene sum to ≈ the scene length
  imagePrompt: string; // shot-specific visual addendum (what THIS shot shows)

  // --- S48 v2 (fields 8–19) ---
  /** Who/what fills the frame — the blocking anchor ("the calligrapher's
   * inkwell", "the Kaaba at dawn"). Empty on v1 plans / when unset. */
  subject?: string;
  /** What the subject is doing in this shot (motion cue for prompts, i2v
   * merit and stock matching). */
  subjectAction?: string;
  cameraHeight?: string; // CAMERA_HEIGHTS
  angle?: string; // ANGLES
  depthOfField?: string; // DEPTHS_OF_FIELD
  lighting?: string; // free text: "golden hour rim light", "soft overcast"
  colorGrade?: string; // free text: "teal-orange", "desaturated documentary"
  /** Where the eye must stay — a motion.ts focal token; empty = the scene's
   * own heuristic (focalForScene) stays in charge. */
  focal?: string; // FOCAL_ANCHORS
  moveSpeed?: string; // MOVE_SPEEDS
  transitionOut?: string; // SHOT_TRANSITIONS
  purpose?: string; // SHOT_PURPOSES
  /** The director's one-line note for the human reviewer. Never executes. */
  notes?: string;
}

/** One scene's direction. */
export interface DirectorScene {
  sceneIndex: number; // 1-based — matches Scene.index
  mood: string; // visual mood: palette + lighting + time-of-day keywords
  transitionIn: string; // transitions.ts id ("" for scene 1 — nothing to blend from)
  motion: string; // motion.ts override hint: smart | zoom | pan | off
  needsI2V: boolean; // animated render mode: does THIS scene merit image-to-video
  useStock: boolean; // real-world / documentary scenes that should use stock b-roll
  pacing: string; // module E: narration speed hint — slow | normal | fast
  ambience: string; // module E: synthesized ambient bed kind (AMBIENCE_KINDS)
  sfx: string; // module E: scene-boundary cue hint (SFX_HINTS)
  /** Module C: recurring set pieces from the org's World library that this
   * scene uses (names — resolved against the library at render time). */
  locations?: string[];
  props?: string[];
  outfit?: string; // cast look for the scene (persisted to CharacterAppearance)
  accessory?: string;
  shots: DirectorShot[];
}

/** The full plan — versioned so old persisted plans stay parseable.
 * S48: version 2 plans carry the 19-field shots; version stays as PERSISTED
 * (provenance only — the parsed in-memory shape is uniformly complete, so
 * consumers never branch on it). */
export interface DirectorPlan {
  version: 1 | 2;
  generatedAt: string; // ISO timestamp
  concept: string; // one-paragraph directorial concept (the "why")
  /** M1: the production profile that authored this plan (a PROFILE_IDS
   *  value). Absent on legacy/pre-M1 plans — consumers normalize via
   *  resolveProfile(plan.profile). Additive: never changes parse shape. */
  profile?: string;
  musicMood?: string; // module E: music.ts mood preset id (consumer-sanitized)
  ducking?: string; // module E: audiomix DuckIntensity id (consumer-sanitized)
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

function asNameList(v: unknown, max: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const names = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, max);
  return names.length > 0 ? names : undefined;
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
        // v2 verbs snap directly; a legacy verb (pre-S48 plan) snaps against
        // the legacy list and is mapped to its engine kind at EXECUTION time
        // (shots.ts) — parse never rewrites what a v1 plan asked for.
        camera: snap(sho.camera, CAMERA_ALL, "static"),
        lens: asString(sho.lens, "35mm").slice(0, 120),
        composition: snap(sho.composition, COMPOSITIONS, "rule of thirds"),
        duration,
        imagePrompt: asString(sho.imagePrompt).slice(0, 400),
        // --- S48 v2 fields (defaults: the honest v1-equivalent behavior) ---
        subject: asString(sho.subject).slice(0, 160),
        subjectAction: asString(sho.subjectAction).slice(0, 160),
        cameraHeight: snap(sho.cameraHeight, CAMERA_HEIGHTS, "eye-level"),
        angle: snap(sho.angle, ANGLES, "front"),
        depthOfField: snap(sho.depthOfField, DEPTHS_OF_FIELD, "deep"),
        lighting: asString(sho.lighting).slice(0, 160),
        colorGrade: asString(sho.colorGrade).slice(0, 120),
        focal: snap(sho.focal, FOCAL_ANCHORS, ""),
        moveSpeed: snap(sho.moveSpeed, MOVE_SPEEDS, "normal"),
        transitionOut: snap(sho.transitionOut, SHOT_TRANSITIONS, "cut"),
        purpose: snap(sho.purpose, SHOT_PURPOSES, "contextualize"),
        notes: asString(sho.notes).slice(0, 200),
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
      pacing: snap(so.pacing, PACINGS, "normal"),
      ambience: snap(so.ambience, AMBIENCE_KINDS, "none"),
      sfx: snap(so.sfx, SFX_HINTS, "none"),
      locations: asNameList(so.locations, 3),
      props: asNameList(so.props, 3),
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
    // Provenance: the version AS PERSISTED (v1 plans stay 1 — the complete
    // in-memory shape is v2 either way, so no consumer ever branches here).
    version: obj.version === 2 ? 2 : 1,
    generatedAt: asString(obj.generatedAt) || new Date().toISOString(),
    concept: asString(obj.concept).slice(0, 600),
    // M1: snap the profile id to the catalog (case-insensitive). Unknown or
    // absent → undefined, so a legacy plan parses byte-identical (no profile
    // field) and consumers normalize via resolveProfile(plan.profile).
    profile: (PROFILE_IDS as readonly string[]).includes(
      asString(obj.profile).toLowerCase()
    )
      ? asString(obj.profile).toLowerCase()
      : undefined,
    // Plan-level audio hints pass through as plain strings — the consumers
    // (music.ts / audiomix.ts) own the vocabularies and sanitize on use.
    musicMood: asString(obj.musicMood).slice(0, 40) || undefined,
    ducking: asString(obj.ducking).slice(0, 16) || undefined,
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
    // S48 v2 prompt clauses — skipped at their default values so v1 plans
    // (and default choices) keep the exact pre-S48 addendum string.
    if (first.cameraHeight && first.cameraHeight !== "eye-level") parts.push(first.cameraHeight);
    if (first.lighting) parts.push(first.lighting);
    if (first.colorGrade) parts.push(`${first.colorGrade} grade`);
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
 * Render-side accessor (module E) — the audio direction from an APPROVED
 * plan in one read: per-scene pacing / ambience / sfx hints (defaults
 * omitted) + the plan-level music mood and ducking suggestions. All empty /
 * null when there is no approved plan — the audio pipeline is untouched.
 */
export interface PlanAudioDirection {
  pacing: Map<number, "slow" | "fast">; // "normal" omitted
  ambience: Map<number, string>; // non-"none" kinds only
  sfx: Map<number, string>; // non-"none" hints only
  musicMood: string | null;
  ducking: string | null;
}

export async function getApprovedAudioMap(videoId: string): Promise<PlanAudioDirection> {
  const out: PlanAudioDirection = {
    pacing: new Map(),
    ambience: new Map(),
    sfx: new Map(),
    musicMood: null,
    ducking: null,
  };
  const video = await db.video.findUnique({
    where: { id: videoId },
    select: { shotList: true, directorState: true },
  });
  if (!video || video.directorState !== "approved") return out;
  const plan = parsePlan(video.shotList);
  if (!plan) return out;
  for (const scene of plan.scenes) {
    if (scene.pacing === "slow" || scene.pacing === "fast") {
      out.pacing.set(scene.sceneIndex, scene.pacing);
    }
    if (scene.ambience !== "none") out.ambience.set(scene.sceneIndex, scene.ambience);
    if (scene.sfx !== "none") out.sfx.set(scene.sceneIndex, scene.sfx);
  }
  out.musicMood = plan.musicMood ?? null;
  out.ducking = plan.ducking ?? null;
  return out;
}

/**
 * Render-side accessor (module C) — the cast's OUTFIT for one scene under an
 * APPROVED plan, as an image-prompt clause. The director pass proposes
 * outfit/accessory per scene (persisted to CharacterAppearance, where the
 * human can edit them in Scene Studio); this closes the loop so the cast
 * actually WEARS the logged look in every painted scene. "" when there is no
 * approved plan / no cast / no logged look — the prompt is untouched.
 */
export async function getApprovedAppearanceClause(
  videoId: string,
  sceneIndex: number
): Promise<string> {
  const video = await db.video.findUnique({
    where: { id: videoId },
    select: {
      directorState: true,
      characterId: true,
      character: { select: { name: true } },
    },
  });
  if (!video || video.directorState !== "approved" || !video.characterId) return "";
  const row = await db.characterAppearance.findUnique({
    where: {
      videoId_sceneIndex_characterId: {
        videoId,
        sceneIndex,
        characterId: video.characterId,
      },
    },
    select: { outfit: true, accessory: true },
  });
  if (!row) return "";
  const look = [row.outfit, row.accessory].filter(Boolean).join(", ");
  if (!look) return "";
  return `${video.character?.name ?? "The host"} is wearing ${look}.`;
}

/**
 * Render-side accessor (module C) — the scene's SET PIECES under an APPROVED
 * plan: the plan's per-scene location / prop names resolve against the org's
 * library and their descriptions join the image prompt (recurring places and
 * objects stay consistent, the same way the cast's identity does).
 */
export async function getApprovedWorldClause(
  videoId: string,
  sceneIndex: number
): Promise<string> {
  const video = await db.video.findUnique({
    where: { id: videoId },
    select: { shotList: true, directorState: true, organizationId: true },
  });
  if (!video || video.directorState !== "approved") return "";
  const scene = parsePlan(video.shotList)?.scenes.find(
    (s) => s.sceneIndex === sceneIndex
  );
  if (!scene) return "";
  const names = new Set([...(scene.locations ?? []), ...(scene.props ?? [])]);
  if (names.size === 0) return "";
  const [locations, props] = await Promise.all([
    db.location.findMany({
      where: { organizationId: video.organizationId, isActive: true },
      select: { name: true, description: true },
    }),
    db.prop.findMany({
      where: { organizationId: video.organizationId, isActive: true },
      select: { name: true, description: true },
    }),
  ]);
  const hits = [...locations, ...props].filter((x) => names.has(x.name));
  if (hits.length === 0) return "";
  return hits
    .slice(0, 4)
    .map((h) => (h.description ? `${h.name}: ${h.description}` : h.name))
    .join("; ");
}

/**
 * Render-side accessor (M2) — the APPROVED plan in ONE read, or null. The
 * shot-execution contract (shots.ts buildSceneShots) consumes this: per-scene
 * DirectorScene → authoritative shot list. Null for proposed/dismissed/absent
 * plans — the render is exactly as before.
 */
export async function getApprovedPlan(videoId: string): Promise<DirectorPlan | null> {
  const video = await db.video.findUnique({
    where: { id: videoId },
    select: { shotList: true, directorState: true },
  });
  if (!video || video.directorState !== "approved") return null;
  return parsePlan(video.shotList);
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
