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
import { sanitizeSfxKind, sanitizeAmbienceKind } from "./studio-sound";
import {
  sanitizeGrade,
  sanitizeTitle,
  sanitizeCamera,
  sanitizeSpeed,
  sanitizeVoiceFades,
  sanitizeChroma,
  sanitizePip,
  sanitizeRenderPrefs,
  type SceneGrade,
  type SceneTitle,
  type SceneCameraKeys,
  type SceneChroma,
  type ScenePip,
  type RenderPrefs,
} from "./studio-doc";

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
  voice: {
    enabled: boolean;
    level: number;
    /** S2 wave 2 — narration fade in/out (seconds, 0..3); absent = none. */
    fadeInSec?: number;
    fadeOutSec?: number;
  }; // 0..1
  music: { enabled: boolean; level: number; ducking: boolean };
  sfx: { enabled: boolean; level: number; kind: string | null };
  ambient: { enabled: boolean; level: number; kind: string | null };
}

export interface TimelineCaption {
  text: string;
  startSec: number;
  endSec: number;
}

// ---------- S87 slice 1 — the v2 tracks projection ----------
//
// The Universal Timeline contract's multi-track shape (S76 §4.C): every
// engine describes its cut as TRACKS of kind video/image/whiteboard/3d/
// character/audio/subtitle/graphics. Slice 1 derives the three scenes-
// backed tracks (visual + audio + subtitle) from the scene list; slices
// 3+ let ENGINES own their tracks (whiteboard's planner, 3D).
//
// THE PROJECTION LAW, ENFORCED STRUCTURALLY (the slice-1 refinement):
// tracks are derived AT SERIALIZATION from the scenes being written —
// never carried through parse-modify-serialize cycles. A carried tracks[]
// goes stale the moment a clip op edits scenes; a derived one cannot
// (every serialize re-derives from the scenes it is handed). A tracks
// field on an in-memory doc is a display echo; the WRITER never reads it.

export type TimelineTrackKind =
  | "video"
  | "image"
  | "whiteboard"
  | "3d"
  | "character"
  | "audio"
  | "subtitle"
  | "graphics";

export interface TimelineClip {
  /** Deterministic clip id — `s{sceneIndex}` (visual), `a-s{sceneIndex}`
   *  (voiceover), `a-music` (the bed), `sub-s{sceneIndex}` (caption). */
  id: string;
  kind: TimelineTrackKind;
  /** The row linkage — the scene this clip projects (null for doc-spanning
   *  clips like the music bed). The row is the truth; clips always point
   *  back at it (design note 1). */
  sceneIndex: number | null;
  /** Timing on the composition clock (seconds). */
  startSec: number;
  endSec: number;
  /** The scene-boundary transitions this clip enters/exits with (null for
   *  non-visual tracks — audio does not blend). */
  transitionIn: string | null;
  transitionOut: string | null;
  /** The asset reference (the stock pointer / source kind). null = the
   *  frame is generated (ai) or the clip is not visual (audio/subtitle). */
  asset: {
    source: SceneSource;
    stockSource: string | null;
    stockQuery: string | null;
  } | null;
}

export interface TimelineTrack {
  kind: TimelineTrackKind;
  name: string;
  clips: TimelineClip[];
}

/** Defensive timing read — a PUT body scene is a client roundtrip cast, so
 *  derivation must tolerate junk timings (0 fallback, never NaN). */
function trackSec(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Derive the v2 tracks projection from a scene list — the pure,
 *  deterministic function serializeTimeline applies on every write.
 *
 *  Three tracks, all scene-backed (the slices-3+ engine tracks land later):
 *  • visual — one clip per scene; kind image when the scene source is
 *    slides (the designed PNG IS the frame), video otherwise (ai/stock);
 *    timing + transitions + the asset reference mirror the scene.
 *  • audio — one clip per scene over the same measured window (the
 *    voiceover/sfx/ambient bed is scene-bound), plus ONE doc-spanning
 *    music-bed clip when the doc says the music is on (the doc mirrors
 *    the per-video music flag identically on every scene; scenes[0] is
 *    the honest read).
 *  • subtitle — clips ONLY where the doc carries a caption block (the
 *    S43 seeding rule: human-edited captions live in the doc; LLM script
 *    captions stay on the row). Caption timing wins over scene timing.
 *
 *  Per-scene mix levels / creative overrides deliberately stay in the
 *  scenes list (the S2 doctrine — clips reference scenes by index;
 *  duplicating levels into clips would fork the truth slice 2 consumes).
 *  Empty scenes → the three tracks with empty clip lists (shape-stable
 *  for the compositor's dispatch). */
export function deriveTracks(scenes: TimelineScene[]): TimelineTrack[] {
  const list = Array.isArray(scenes) ? scenes : [];
  const visualKind: TimelineTrackKind = list[0]?.source === "slides" ? "image" : "video";

  const visualClips: TimelineClip[] = list.map((s) => ({
    id: `s${s?.index ?? 0}`,
    kind: s?.source === "slides" ? "image" : "video",
    sceneIndex: typeof s?.index === "number" ? s.index : null,
    startSec: trackSec(s?.startSec),
    endSec: trackSec(s?.endSec),
    transitionIn: typeof s?.transitionIn === "string" ? s.transitionIn : null,
    transitionOut: typeof s?.transitionOut === "string" ? s.transitionOut : null,
    asset: {
      source: s?.source === "slides" ? "slides" : s?.source === "stock" ? "stock" : "ai",
      stockSource: typeof s?.stockSource === "string" ? s.stockSource : null,
      stockQuery: typeof s?.stockQuery === "string" ? s.stockQuery : null,
    },
  }));

  const audioClips: TimelineClip[] = list.map((s) => ({
    id: `a-s${s?.index ?? 0}`,
    kind: "audio",
    sceneIndex: typeof s?.index === "number" ? s.index : null,
    startSec: trackSec(s?.startSec),
    endSec: trackSec(s?.endSec),
    transitionIn: null,
    transitionOut: null,
    asset: null,
  }));
  const musicOn = list[0]?.audio?.music?.enabled === true;
  if (musicOn && list.length > 0) {
    const total = Math.max(...list.map((s) => trackSec(s?.endSec)));
    audioClips.push({
      id: "a-music",
      kind: "audio",
      sceneIndex: null, // doc-spanning bed — not scene-bound
      startSec: 0,
      endSec: total,
      transitionIn: null,
      transitionOut: null,
      asset: null,
    });
  }

  const subtitleClips: TimelineClip[] = list
    .filter((s) => typeof s?.caption?.text === "string" && s.caption.text.trim().length > 0)
    .map((s) => ({
      id: `sub-s${s.index}`,
      kind: "subtitle" as const,
      sceneIndex: typeof s.index === "number" ? s.index : null,
      startSec: trackSec(s.caption?.startSec ?? s.startSec),
      endSec: trackSec(s.caption?.endSec ?? s.endSec),
      transitionIn: null,
      transitionOut: null,
      asset: null,
    }));

  return [
    { kind: visualKind, name: "visual", clips: visualClips },
    { kind: "audio", name: "audio", clips: audioClips },
    { kind: "subtitle", name: "subtitle", clips: subtitleClips },
  ];
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
  /** S2 wave 2 — per-scene creative overrides. Optional + absent from the
   *  assembly seed (the classic look is the default), present once edited. */
  grade?: SceneGrade | null;
  titleOverlay?: SceneTitle | null;
  cameraKeys?: SceneCameraKeys | null;
  speed?: number | null;
  /** S3 — chroma key + corner logo overlay (absent = none). */
  chroma?: SceneChroma | null;
  pip?: ScenePip | null;
}

export interface AssembledTimeline {
  /** S87 — the doc's schema stamp. 1 = the scene-level projection (slice 0);
   *  2 = the doc that also carries the derived v2 tracks (slice 1). A build
   *  that knows version N reads N and N−1 — a build meeting an UNKNOWN
   *  stamp must treat the doc as unreadable (parseTimeline → null → the
   *  render recomputes inline) and NEVER overwrite it (the slice-1
   *  guardTimelineOverwrite law). Legacy docs without the stamp parse as
   *  v1 (the tolerant-read law). */
  schema: 1 | 2;
  scenes: TimelineScene[];
  /** S87 slice 1 — the derived v2 tracks projection. In memory this is a
   *  display convenience; the WRITER re-derives at serialization (the
   *  projection law, enforced structurally — a stale copy cannot persist). */
  tracks: TimelineTrack[];
  sceneCount: number;
  totalDurationSec: number;
  generatedAt: string;
  /** S3 — render preferences persisted with the doc (quality tier; the
   *  aspect/fps/burnCaptions live on the video row). Absent = standard. */
  renderPrefs?: RenderPrefs | null;
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

    // S43 — seed the doc's caption slot ONLY from human-edited captions
    // (captionUser, set by the Scene Studio PATCH). The script LLM fills
    // `caption` on every scene; seeding those here made every assembled doc
    // override the word-synced narration chunks with one frozen LLM line per
    // scene, and froze the assembly snapshot against later row edits.
    const caption: TimelineCaption | null =
      scene.captionUser && scene.caption
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
    // S87 slice 1 — assemble builds the v2 doc (the writer re-stamps at
    // serialization; the in-memory stamp describes the doc's shape).
    schema: 2,
    scenes: out,
    tracks: deriveTracks(out),
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
  /** S2 wave 2 — creative layer. Null = classic render behavior. */
  grade: SceneGrade | null;
  titleOverlay: SceneTitle | null;
  cameraKeys: SceneCameraKeys | null;
  speed: number | null;
  /** Per-scene narration fade in/out (null = no afade). */
  voiceFades: { inSec: number; outSec: number } | null;
  /** S3 — chroma key / corner logo overlay (null = none). */
  chroma: SceneChroma | null;
  pip: ScenePip | null;
  /** S5 — the studio's sound picks (null = no override — the plan's cue/bed
   *  wins). Sanitized against the studio-sound catalogs at the extraction
   *  choke point; the render resolves precedence with resolveSoundChoice. */
  sfxKind: string | null;
  ambientKind: string | null;
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
    // S2 wave 2 — the creative layer, re-sanitized at the extraction choke
    // point (the UI normalizes on load too; both call studio-doc's exact
    // functions so a hostile persisted doc can never reach the render raw).
    grade: sanitizeGrade(s.grade),
    titleOverlay: sanitizeTitle(s.titleOverlay),
    cameraKeys: sanitizeCamera(s.cameraKeys),
    speed: sanitizeSpeed(s.speed),
    voiceFades: sanitizeVoiceFades(s.audio?.voice?.fadeInSec, s.audio?.voice?.fadeOutSec),
    // S3 — keying + overlay, sanitized at the same choke point.
    chroma: sanitizeChroma(s.chroma),
    pip: sanitizePip(s.pip),
    // S5 — the sound picks, sanitized at the same choke point (the UI
    // normalizes on load too; both call studio-sound's exact functions so a
    // hostile persisted doc can never reach the render raw).
    sfxKind: sanitizeSfxKind(s.audio?.sfx?.kind),
    ambientKind: sanitizeAmbienceKind(s.audio?.ambient?.kind),
  }));
}

/** Parse a persisted timeline JSON. Tolerant of legacy/null — null when the
 *  structure is unreadable (the render falls back to recomputing inline).
 *  S87 — the schema stamp: absent = legacy v1 (docs predate the field),
 *  1 = the scene-level projection, 2 = the doc that also carries the v2
 *  tracks (this build re-derives tracks from the scenes — a stored copy is
 *  never trusted on read, so junk tracks cannot enter memory). Any OTHER
 *  stamp = a doc this build does not know → null (never a guessed parse;
 *  the render recomputes inline, and guardTimelineOverwrite keeps every
 *  write path from destroying the newer doc). */
export function parseTimeline(json: string | null | undefined): AssembledTimeline | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const obj = raw as { schema?: unknown; scenes?: unknown; sceneCount?: unknown; totalDurationSec?: unknown; generatedAt?: unknown; renderPrefs?: unknown };
    // A build reads N and N−1: this build knows 2, so 2, 1 and absent
    // (legacy v1) parse; anything else refuses.
    const known = obj.schema === undefined || obj.schema === 1 || obj.schema === 2;
    if (!known) return null; // unknown future schema — refuse, never guess
    if (!Array.isArray(obj.scenes)) return null;
    const scenes = obj.scenes as TimelineScene[];
    return {
      schema: obj.schema === 2 ? 2 : 1,
      scenes,
      // The tracks projection is ALWAYS re-derived from the parsed scenes —
      // tolerant read of junk tracks (they never enter memory), and the
      // roundtrip (serialize → parse → serialize) holds by construction.
      tracks: deriveTracks(scenes),
      sceneCount: Number(obj.sceneCount) || 0,
      totalDurationSec: Number(obj.totalDurationSec) || 0,
      generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : new Date().toISOString(),
      // S3 — render prefs ride the root (dropped silently when corrupt).
      renderPrefs: sanitizeRenderPrefs(obj.renderPrefs),
    };
  } catch {
    return null;
  }
}

/** The doc's scene vocabulary — serializeTimeline emits EXACTLY these keys,
 *  in this order, nothing else. A hostile client (or a lost older doc) can
 *  carry junk keys (`art`, `image`, `poster`, …) in the persisted column;
 *  passthrough parsing tolerates them on read, but the WRITER never stores
 *  what the type doesn't declare — the same "never passed through" doctrine
 *  the S2/S3 sanitizers apply to the known fields. */
const TIMELINE_SCENE_FIELDS = [
  "index",
  "title",
  "narration",
  "visual",
  "startSec",
  "endSec",
  "durationSec",
  "transitionIn",
  "transitionOut",
  "audio",
  "caption",
  "source",
  "stockSource",
  "stockQuery",
  "shot",
  "grade",
  "titleOverlay",
  "cameraKeys",
  "speed",
  "chroma",
  "pip",
] as const;

export function serializeTimeline(timeline: AssembledTimeline): string {
  return JSON.stringify({
    // S87 slice 1 — the writer owns the contract version: every persisted
    // doc is stamped 2 and carries the tracks derived FROM THE SCENES IT IS
    // HANDED (the refinement: derive at serialization — no write path can
    // persist stale tracks). The doc's in-memory .tracks is never read here.
    schema: 2,
    scenes: timeline.scenes.map((s) => {
      const rec = s as unknown as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const f of TIMELINE_SCENE_FIELDS) {
        if (f in rec) out[f] = rec[f];
      }
      return out;
    }),
    // The v2 projection, derived from the same scenes written above —
    // structurally incapable of going stale (the slice-1 refinement).
    tracks: deriveTracks(timeline.scenes),
    sceneCount: timeline.sceneCount,
    totalDurationSec: timeline.totalDurationSec,
    generatedAt: timeline.generatedAt,
    ...(timeline.renderPrefs ? { renderPrefs: timeline.renderPrefs } : {}),
  });
}

// ---------- S87 slice 1 — the overwrite guard ----------
//
// The forward-compat hazard the version stamp exposes: a build meeting an
// unknown-stamp doc parses it as null, recomputes a fresh projection, and
// a naive write path would DESTROY a newer build's doc with an older-
// schema one. One law, six write paths (assemble POST + PUT, the scenes
// route's caption sync, studio clip/voice/pace): read the RAW stored
// stamp; a doc this build cannot parse must never be overwritten. The
// explicit DELETE /assemble stays unguarded — it IS the human's escape
// hatch, a deliberate decision rather than a blind clobber.

export type TimelineOverwriteGuard = { blocked: false } | { blocked: true; storedSchema: unknown };

/** The 409 body for a refused overwrite — every guarded route answers with
 *  this message so clients match one string. */
export const TIMELINE_OVERWRITE_ERROR =
  "A newer-schema timeline doc is stored — this build cannot read it, so the write was refused " +
  "(clear it explicitly via DELETE /assemble if you really want to start over)";

/** Inspect the RAW stored timeline JSON (never the parsed doc — the parse
 *  of an unknown stamp is null and loses the stamp). Blocked when the
 *  stored doc carries a stamp this build does not parse (not absent, not
 *  1, not 2). Corrupt JSON / non-object bodies are NOT newer docs — the
 *  fail-open law applies (the render recomputes inline anyway), so the
 *  write proceeds. */
export function guardTimelineOverwrite(stored: string | null | undefined): TimelineOverwriteGuard {
  if (!stored) return { blocked: false };
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return { blocked: false }; // corrupt ≠ newer — legacy fail-open
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { blocked: false };
  const schema = (raw as { schema?: unknown }).schema;
  if (schema === undefined || schema === 1 || schema === 2) return { blocked: false };
  return { blocked: true, storedSchema: schema };
}
