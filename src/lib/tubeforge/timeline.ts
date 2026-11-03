// timeline.ts — Stage 6 scene assembly (T-6.1).
//
// Pure functions that build the "preview timeline" from a video row's
// scenes + shotList + audio settings. POST /api/videos/[id]/assemble returns
// this JSON; the render job consumes the SAVED version (PUT /assemble) instead
// of recomputing inline (T-6.10 — a later task in this stage).
//
// The timeline is the user-editable preview of what the render will produce:
//   * per-scene start/end times from the scene's MEASURED read length when
//     the per-scene WAV exists (wavDurations — the exact segment the render
//     will build: wav + lead + tail, MIN_SEG floor), falling back to the
//     narration word count + TTS speed estimate for scenes not yet voiced;
//   * per-scene transition in/out from the video override or the approved
//     shot plan (so the user sees what the AI Director picked);
//   * per-scene audio levels (voice / music / SFX / ambient) from the video
//     settings + scene mood (the same resolvers the render uses);
//   * per-scene caption text + timing (the scene's caption field, timed to the
//     scene's voiceover window);
//   * the source kind (ai | stock | slides) and the stock reference when set.
//
// Two design notes:
//  1. The timeline is a PROJECTION — never the source of truth. The video
//     row (scenes, shotList, music*) is. Saving a user-edited timeline
//     writes the edited fields back to the row; the timeline column just
//     caches the assembled form for the render job.
//  2. Estimated durations silently TRIM at render time (the render honors
//     doc windows positionally — T-6.10): a scene whose real read runs
//     longer than its word-count share would lose its last words without
//     anyone editing anything. That is why measured WAV lengths win whenever
//     they exist — the assembled doc starts honest, and the user's explicit
//     trims (shorter windows) are the only cuts the render makes.

import type { Scene } from "./types";
import type { DirectorPlan } from "./director-plan";
import { planSceneDuration, planTransitionIn } from "./director-plan";
import { sanitizeTransition, TRANSITION_IDS, type TransitionStyle } from "./transitions";
import { R_LEAD_SEC, R_TAIL_SEC, R_MIN_SEG_SEC } from "./preview-lanes";

export type SceneSource = "ai" | "stock" | "slides";

export interface TimelineShot {
  framing: string | null;
  camera: string | null;
  lens: string | null;
  composition: string | null;
  motion: string | null;
  mood: string | null;
}

export interface TimelineAudio {
  voice: { enabled: boolean; level: number }; // 0..1
  music: { enabled: boolean; level: number; ducking: boolean };
  sfx: { enabled: boolean; level: number; kind: string | null };
  ambient: { enabled: boolean; level: number; kind: string | null };
}

export interface TimelineCaption {
  text: string;
  startSec: number;
  endSec: number;
}

export interface TimelineScene {
  index: number;
  title: string;
  narration: string;
  visual: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  transitionIn: string | null;
  transitionOut: string | null;
  audio: TimelineAudio;
  caption: TimelineCaption | null;
  source: SceneSource;
  stockSource: string | null; // "pexels" | "pixabay" | null
  stockQuery: string | null;
  shot: TimelineShot | null;
}

export interface AssembledTimeline {
  scenes: TimelineScene[];
  sceneCount: number;
  totalDurationSec: number;
  generatedAt: string;
}

// ---------- helpers ----------

/** Estimate a scene's narration duration in seconds. TTS at 1.0× averages
 *  ~150 words per minute (2.5 wps) for the studio voices; pace scales that.
 *  Adds a 0.4 s scene lead-in (the lead-in the compositor places before each
 *  scene's narration) and clamps to a sensible minimum so a one-word scene
 *  doesn't read as zero seconds. */
export function estimateNarrationSec(narration: string, ttsSpeed = 1): number {
  const words = narration.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 1.5; // silent scene still needs a visible beat
  const wps = 2.5 * (Number.isFinite(ttsSpeed) && ttsSpeed > 0 ? ttsSpeed : 1);
  return Math.max(1.5, words / wps + 0.4);
}

/** Total estimated duration across scenes — used when no measured voiceover
 *  length is available. */
export function sumEstimatedDuration(scenes: Scene[], ttsSpeed = 1): number {
  return scenes.reduce((acc, s) => acc + estimateNarrationSec(s.narration, ttsSpeed), 0);
}

/** Distribute the measured voiceover length across scenes proportional to
 *  each scene's word count. Falls back to the estimate when no measured
 *  audio exists; always returns one duration per scene in the same order. */
function deriveSceneDurations(
  scenes: Scene[],
  audioDurationSec: number | null,
  ttsSpeed: number
): number[] {
  if (scenes.length === 0) return [];
  const estimates = scenes.map((s) => estimateNarrationSec(s.narration, ttsSpeed));
  const totalEstimate = estimates.reduce((a, b) => a + b, 0);
  if (!audioDurationSec || audioDurationSec <= 0) return estimates;
  // Proportional split — keeps a long monologue scene longer than a punchy one.
  return estimates.map((e) => (e / totalEstimate) * audioDurationSec);
}

const SFX_LEVEL: Record<string, number> = {
  whoosh: 0.35,
  boom: 0.55,
  riser: 0.4,
  sting: 0.45,
  none: 0,
};

// ---------- assembly ----------

export interface AssembleOptions {
  shotPlan?: DirectorPlan | null;
  transitionStyle?: string | null;
  transitionDuration?: number | null;
  audioDurationSec?: number | null;
  ttsSpeed?: number;
  renderMode?: string;
  /** Per-video music overrides (null = defaults). */
  musicEnabled?: boolean | null;
  musicVolume?: number | null;
  musicDucking?: boolean | null;
  /** Measured per-scene read lengths (sceneIndex → seconds) — the same map
 *  the assemble GET returns from disk. When present for a scene, its window
 *  is the render's exact segment (wav + lead + tail, MIN_SEG floor) instead
 *  of a word-count estimate, so an assembled doc never silently trims a
 *  long read. */
  wavDurations?: Record<number, number> | null;
}

/** Build the preview timeline from scenes + the per-video/per-plan options. */
export function assembleTimeline(scenes: Scene[], opts: AssembleOptions = {}): AssembledTimeline {
  const ttsSpeed = Number.isFinite(opts.ttsSpeed) && (opts.ttsSpeed ?? 0) > 0 ? (opts.ttsSpeed as number) : 1;
  const durations = deriveSceneDurations(scenes, opts.audioDurationSec ?? null, ttsSpeed);
  const plan = opts.shotPlan ?? null;
  const renderMode = opts.renderMode ?? "kenburns";

  // Music + SFX defaults mirror the render's resolvers (music.ts / sfx.ts).
  // The timeline is a PROJECTION — the render is the source of truth.
  const musicEnabled = opts.musicEnabled ?? true;
  const musicVolume = opts.musicVolume ?? 0.6;
  const musicDucking = opts.musicDucking ?? true;

  let cursor = 0;
  // First pass: per-scene transitionIn + duration (transitionOut for scene N
  // is the transitionIn for scene N+1 — precomputed here so the map below can
  // emit both fields without revisiting the plan).
  const perSceneTransitionIn = scenes.map((scene) => {
    const videoTransition = sanitizeTransition({
      style: opts.transitionStyle ?? null,
      durationSec: opts.transitionDuration ?? null,
    });
    const planTransition = plan ? planTransitionIn(plan, scene.index) : null;
    return planTransition || videoTransition.style;
  });

  const out: TimelineScene[] = scenes.map((scene, i) => {
    // Plan-determined duration can only EXTEND a scene beyond its narration
    // share (deliberate dramatic hold) — never shorten it. The narration
    // share is the floor: a plan whose invented pacing totals less than the
    // measured voiceover (Battle Yamuk: 111 s plan vs 143 s narration)
    // otherwise ships a timeline that cuts words at render time.
    const planDuration = plan ? planSceneDuration(plan, scene.index) : 0;
    // Measured read wins over the estimate (see design note 2 above): the
    // render builds this scene's segment as wav + lead + tail (MIN_SEG
    // floor) — mirror it exactly, the way clip-ops' sceneSegmentSec does.
    const realWav = opts.wavDurations?.[scene.index] ?? null;
    const narrationSec =
      realWav && realWav > 0
        ? Math.max(R_MIN_SEG_SEC, realWav + R_LEAD_SEC + R_TAIL_SEC)
        : Math.max(0.5, durations[i] ?? 1.5);
    const durationSec = planDuration > 0 ? Math.max(planDuration, narrationSec) : narrationSec;
    const startSec = cursor;
    const endSec = cursor + durationSec;
    cursor = endSec;

    const transitionIn = perSceneTransitionIn[i];
    // transitionOut of scene N = transitionIn of scene N+1; the LAST scene
    // fades to black by convention.
    const transitionOut = i < scenes.length - 1 ? perSceneTransitionIn[i + 1] : "fade";

    // Shot — only present under an approved plan (mirrors the render hook
    // in story.ts; proposed/dismissed plans never reach the visual pipeline).
    const shotScene = plan?.scenes.find((s) => s.sceneIndex === scene.index) ?? null;
    const shot0 = shotScene?.shots[0] ?? null;
    const shot: TimelineShot | null = shot0
      ? {
          framing: shot0.framing ?? null,
          camera: shot0.camera ?? null,
          lens: shot0.lens ?? null,
          composition: shot0.composition ?? null,
          // motion lives on DirectorScene (per-scene), not DirectorShot.
          motion: shotScene?.motion ?? null,
          mood: shotScene?.mood ?? null,
        }
      : null;

    // Audio: per-scene SFX (scene.sfx) + plan-level ambient kind; the music
    // bed is per-video (the resolver picks one track for the whole video).
    const sfxKind = scene.sfx && scene.sfx !== "none" ? scene.sfx : null;
    const ambientKind = shotScene?.ambience ?? null;

    const source: SceneSource =
      renderMode === "slides" ? "slides" : renderMode === "stock" && scene.stock ? "stock" : "ai";

    const caption: TimelineCaption | null = scene.caption
      ? { text: scene.caption, startSec, endSec }
      : null;

    return {
      index: scene.index,
      title: scene.title,
      narration: scene.narration,
      visual: scene.visual,
      startSec: Math.round(startSec * 100) / 100,
      endSec: Math.round(endSec * 100) / 100,
      durationSec: Math.round(durationSec * 100) / 100,
      transitionIn,
      transitionOut,
      audio: {
        voice: { enabled: true, level: 1.0 },
        music: { enabled: musicEnabled, level: musicVolume, ducking: musicDucking },
        sfx: {
          enabled: sfxKind !== null,
          level: sfxKind ? (SFX_LEVEL[sfxKind] ?? 0.35) : 0,
          kind: sfxKind,
        },
        ambient: {
          enabled: ambientKind !== null,
          // Mirrors the render mix (sceneAudio): beds sit at 0.10 —
          // synthesized noise beds any louder read as constant hiss.
          level: ambientKind ? 0.1 : 0,
          kind: ambientKind,
        },
      },
      caption,
      source,
      stockSource: scene.stock?.source ?? null,
      stockQuery: scene.stock?.query ?? null,
      shot,
    };
  });

  return {
    scenes: out,
    sceneCount: out.length,
    totalDurationSec: Math.round(cursor * 100) / 100,
    generatedAt: new Date().toISOString(),
  };
}

// ---------- (de)serialization for the Video.timeline column ----------

// ---------- doc overlay (S2 — what the render reads back) ----------
//
// The saved timeline doc is the Studio's editable projection of the video
// row. S2 makes the render CONSUME the edited fields instead of just the
// durations: per-scene transition style, per-scene audio levels, per-scene
// caption text. This interface is that bridge — extracted from the doc,
// sanitized, aligned BY POSITION to the row's scenes (the sceneOrder
// contract keeps them in the same play order).

export interface DocSceneSettings {
  /** Valid catalog transition id for the seam INTO this scene (null = no
   *  override — the video-level style wins). */
  transitionIn: string | null;
  /** 0..1 narration level (null = doc silent — render default 1.0). */
  voiceLevel: number | null;
  /** 0..1 music-bed level for this scene's window (null = no override). */
  musicLevel: number | null;
  /** 0..1 SFX cue weight (null = no override — render default 0.35). */
  sfxLevel: number | null;
  /** 0..1 ambience bed weight (null = no override — render default 0.10). */
  ambientLevel: number | null;
  /** Edited caption text (null = no override — the row's field wins). */
  caption: string | null;
}

/** Clamp a doc level into 0..1; anything absent/out-of-range is null (no
 *  override — never a silent clamp that would mask a corrupt doc). */
function docLevel(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/**
 * Extract the render-facing per-scene settings from a saved timeline doc.
 * Returns null when the doc is absent or out of alignment with the scene
 * count (the same guard the duration consumption uses — a stale doc must
 * never reach the render partially). Docs saved by older studio versions
 * may lack audio/caption blocks; every field is optional-chained so those
 * docs read as "no override" instead of crashing.
 */
export function docSceneSettings(
  timeline: AssembledTimeline | null,
  sceneCount: number
): DocSceneSettings[] | null {
  if (!timeline || !Array.isArray(timeline.scenes)) return null;
  if (timeline.scenes.length !== sceneCount || sceneCount === 0) return null;
  return timeline.scenes.map((s) => ({
    transitionIn:
      typeof s.transitionIn === "string" && TRANSITION_IDS.has(s.transitionIn as TransitionStyle)
        ? s.transitionIn
        : null,
    voiceLevel: docLevel(s.audio?.voice?.level),
    musicLevel: docLevel(s.audio?.music?.level),
    sfxLevel: docLevel(s.audio?.sfx?.level),
    ambientLevel: docLevel(s.audio?.ambient?.level),
    caption:
      typeof s.caption?.text === "string" && s.caption.text.trim().length > 0
        ? s.caption.text
        : null,
  }));
}

/** Parse a persisted timeline JSON. Tolerant of legacy/null — null when the
 *  structure is unreadable (the render falls back to recomputing inline). */
export function parseTimeline(json: string | null | undefined): AssembledTimeline | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const obj = raw as { scenes?: unknown; sceneCount?: unknown; totalDurationSec?: unknown; generatedAt?: unknown };
    if (!Array.isArray(obj.scenes)) return null;
    return {
      scenes: obj.scenes as TimelineScene[],
      sceneCount: Number(obj.sceneCount) || 0,
      totalDurationSec: Number(obj.totalDurationSec) || 0,
      generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function serializeTimeline(timeline: AssembledTimeline): string {
  return JSON.stringify(timeline);
}
