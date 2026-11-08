// Video compositor — assembles the final MP4 from storyboard art + per-scene
// voiceover using ffmpeg, in three modes:
//   • kenburns  — cinematic pans/zooms over still art (fast, ~realtime/3)
//   • stock     — real Pexels/Pixabay footage per matched scene, Smart Motion
//                 art for the rest (the hybrid)
//   • animated  — every scene animated via CogVideoX image-to-video (~4 min/scene)
// Pipeline: per-scene segments (video+audio) -> transitions/concat ->
// subtitles/music pass. "cut" stitches with the stream-copy concat demuxer;
// any other transition (src/lib/tubeforge/transitions.ts) runs one chained
// xfade/acrossfade pass so scenes blend instead of snapping.
// All commands run via execFile (no shell) so filter strings need only
// ffmpeg-internal quoting, never shell quoting.

import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import type { Scene } from "./types";
import { sceneImageFile, sceneWavFile, buildSrtFromSegments } from "./story";
import { buildSmartSrt, captionOverridesFor } from "./captions";
import { videoDir } from "./ai";
import { zaiClientFor } from "./zai-client";
import { zaiVideoViaClient } from "./providers/zai-video-core";
import * as storage from "./storage";
import { aiCall } from "./budget";
import { log } from "./log";
import { ensureSfx } from "./sfx";
import { resolveSoundChoice, SFX_CATALOG, AMBIENCE_CATALOG } from "./studio-sound";
import {
  voiceSplitChain,
  bedChain,
  droneBedChain,
  duckChain,
  mixTail,
  measureLoudness,
  normalizationFilter,
  sanitizeDuckIntensity,
  musicLevelAutomation,
  type DuckIntensity,
} from "./audiomix";
import { getCapability, VIDEO_DEFAULT_MODEL } from "./providers/settings";
import { runProcess } from "./proc";
import {
  planSlides,
  renderSlidePngs,
  slidePngPath,
  slideMotionPlan,
  slideSegmentGraph,
  type SlideBrand,
} from "./slides";
import {
  planSceneMovements,
  sceneFilterGraph,
  multiShotSceneGraph,
  shotGraphJoins,
  focalForScene,
  sanitizeMotion,
  studioCameraPlan,
  PALINDROME_LOOP_GRAPH,
  OUTPUT_SIZES,
  type MotionScenePlan,
  type MotionSettings,
  type MoveKind,
  type SceneContext,
  type ShotJoinMark,
} from "./motion";
import {
  gradeFilter,
  titleDrawtextFilter,
  chromaFilterChain,
  pipOverlayFilter,
  QUALITY_ENCODING,
  captionAssStyle,
  type SceneGrade,
  type SceneTitle,
  type SceneCameraKeys,
  type SceneChroma,
  type ScenePip,
  type ExportQuality,
} from "./studio-doc";
import { getApprovedMotionMap, getApprovedAudioMap, getApprovedPlan, type DirectorScene } from "./director-plan";
import { buildSceneShots, ensureShotImages, PSEUDO_CROPS, type SceneShotPlan } from "./shots";
import { sanitizePromptForPolicy } from "./restricted-subjects";
import { getVideoContentPolicy } from "./story";
// S35 — Universal Scene Liveliness: the per-scene channel selector + the
// plan-aware i2v motion prompt. The renderer reads the world once (plan,
// provider, stock files) and the PURE selector decides who plays.
import {
  selectChannels,
  i2vMotionPrompt,
  type LivelinessChannel,
  type LivelinessDecision,
} from "./liveliness";
import { ensureAmbience } from "./ambience";
import {
  BLEND_GROUP_MAX,
  sanitizeTransition,
  sanitizeTransitionStyle,
  buildTransitionGraphMulti,
  fadeblackWindowsMulti,
  partitionByCuts,
  planBlendGroupsMulti,
  shiftSegmentsForBlendMulti,
  TRANSITION_IDS,
  type TransitionSettings,
} from "./transitions";
import type { DocSceneSettings } from "./timeline";
import { MUSIC_SLIDER_GAIN } from "./music";
import { expectedCutsForTimeline } from "./render-qc";
import type { ExpectedCuts } from "./render-qc";

// S57/T-57.2 — the module's logger (the old [render] prefix became a binding).
const renderLog = log.child({ mod: "render" });

const _execFileAsync = promisify(execFile);

const FPS = 30;
export const LEAD_SEC = 0.35; // silence before narration starts in each scene
export const TAIL_SEC = 0.85; // breathing room after narration ends
export const MIN_SEG_SEC = 2.0;
// S6 — the caption looks moved to studio-doc.ts's CAPTION_STYLES catalog
// (one vocabulary for the studio pick, the render burn and the preview).
// captionAssStyle(null, false/true) reproduces the pre-S6 constants
// byte-for-byte; a hostile pick can only ever select a catalog look.
// The classic finishing grade moved to studio-doc.ts's gradeFilter (null →
// "eq=contrast=1.05:saturation=1.08,vignette=PI/5") — ONE function owns the
// default so the doc override and the fallback can never drift.

/**
 * S2 wave 2 — the per-scene grade: the doc's edited grade wins scene by
 * scene; null/absent falls back to the classic look. One function owns the
 * mapping so the preview badge and the render can never drift.
 */
function gradeForScene(docGrade: SceneGrade | null | undefined): string {
  return gradeFilter(docGrade);
}

/** A library music track resolved for this render (music.ts). */
export interface ResolvedTrack {
  filePath: string; // absolute path to the track file (flac/wav)
  gain: number; // linear bed gain (track is anchored at -16 LUFS)
  fadeInSec: number;
  fadeOutSec: number;
  /** How hard the bed ducks under the voice (audiomix.ts catalog). */
  duckIntensity: DuckIntensity;
}

export interface RenderOptions {
  videoId: string;
  scenes: Scene[];
  mode: "kenburns" | "animated" | "stock" | "slides";
  burnSubtitles: boolean;
  smartCaptions: boolean; // audio-synced cues (silence + ASR alignment) vs one caption per scene
  music: boolean;
  musicNiche?: string; // selects the per-niche music bed profile (drone fallback)
  musicTrack?: ResolvedTrack | null; // library track — wins over the drone when set
  /** Ducking intensity for the synthesized-drone fallback path. */
  musicDuck?: DuckIntensity;
  /** Sound-effect cues on/off (Settings → Sound; default on). */
  sfx?: boolean;
  sceneLimit?: number; // render only the first N scenes (preview render)
  /** Smart Motion settings (null/undefined = defaults — Smart Motion on, 12%). */
  motion?: MotionSettings | null;
  /** Scene transitions (undefined = built-in default — crossfade 0.5s). */
  transition?: TransitionSettings | null;
  /** Video-level context so scene classification can read tone/niche. */
  motionContext?: SceneContext;
  /** Video topic — drives the slide deck's art direction (slides mode). */
  topic?: string;
  /** Brand kit overrides for keynote slides (accent recolor + logo badge). */
  brand?: SlideBrand | null;
  /** Stage 6 (T-6.8) — per-render aspect ratio override (default "16:9";
   *  slides mode is always "9:16"; "1:1" is honored for the other modes). */
  aspectRatio?: "16:9" | "9:16" | "1:1";
  /** Stage 6 (T-6.8) — per-render frame-rate override (24 | 30 | 60). The
   *  render pipeline's FPS constant becomes a runtime value; downstream
   *  ffmpeg `-r` and `-framerate` flags read this instead. Default 30. */
  frameRate?: 24 | 30 | 60;
  /** Stage 6 (T-6.10) — per-scene durations (seconds) from the assembled
   *  timeline. When present and aligned to the scene list, these OVERRIDE
   *  the per-scene voiceover-derived durations (so the Editing Studio's
   *  trims survive the render). Out-of-range or malformed values fall back
   *  to the measured WAV durations — the timeline is a projection, never
   *  the source of truth. */
  sceneDurationsSec?: number[];
  /** S2 — per-scene settings from the SAVED timeline doc (the Timeline
   *  Studio's edited projection): per-boundary transition styles, per-scene
   *  voice/music/SFX/ambience levels, per-scene caption text. Aligned BY
   *  POSITION to `scenes` (the sceneOrder contract keeps row and doc in the
   *  same play order); null/absent fields fall back to the video-level
   *  behavior, so a missing or stale doc changes nothing. */
  docScenes?: DocSceneSettings[] | null;
  /** S3 — delivery encode tier (draft CRF 26 / standard 20 / high 18;
   *  default standard). Rides the segments, the blend masters and the
   *  subtitle-burn pass. */
  quality?: ExportQuality;
  /** S6 — the timeline doc's caption-style pick (a CAPTION_STYLES id, already
   *  sanitized by the doc parse). null/absent = the classic look. Slides
   *  mode burns the pick's vertical variant. */
  captionStyleId?: string | null;
  onProgress?: (current: number, total: number, label: string) => void;
}

export interface RenderResult {
  fileName: "final.mp4" | "preview.mp4";
  durationSec: number;
  fileBytes: number;
  /** Frame geometry — "9:16" for keynote-slide renders, "1:1" for square
   *  renders, "16:9" otherwise. */
  aspect: "16:9" | "9:16" | "1:1";
  /** Designed black-dip windows (fadeblack blends) for the transition-aware QC gate. */
  blackWindows?: [number, number][];
  /** S36 — where the assembled timeline says cuts and blend windows sit on
   *  the blended clock; the QC cut-alignment lens holds the pixels to it. */
  expectedCuts?: ExpectedCuts;
  /** S35 — the per-scene liveliness ledger: which channel played and why.
   *  Reflects what PLAYED (an i2v scene that fell back mid-render reports
   *  the fallback), so the render row and the worklog can audit the
   *  selector's decisions against the pixels. */
  liveliness: LivelinessDecision[];
}

/**
 * DELETE artifacts that become stale when the storyboard, slide designs, or
 * brand kit change: rendered MP4s, subtitles, animated scene clips and
 * (optionally) the cached slide PNGs. Routes call this after any visual
 * mutation so a stale video can never be served or marked hasVideo.
 *
 * Stage 4a (T-4.0): storage-backed — list + targeted remove through the
 * driver, so it works under s3 (where a raw readdir sees nothing) and
 * decrements the org quota. Local scratch copies die with the same pass
 * (the local driver's remove() IS the scratch file).
 */
export async function invalidateRenderedArtifacts(
  videoId: string,
  opts: { slidePngs?: boolean } = {}
): Promise<void> {
  const stalePattern = opts.slidePngs
    ? /\/(final\.mp4|preview\.mp4|subtitles\.srt|scene-\d{2}\.mp4|slide-\d{2}\.png)$/
    : /\/(final\.mp4|preview\.mp4|subtitles\.srt|scene-\d{2}\.mp4)$/;
  const keys = await storage.list(videoId).catch(() => [] as string[]);
  const stale = keys.filter((k) => stalePattern.test(k));
  await Promise.all(stale.map((k) => storage.remove(k).catch(() => {})));
}

/** Run ffmpeg/ffprobe, surfacing the useful tail of stderr on failure.
 * Uses the zombie-aware runner (proc.ts): under bun, after Playwright has
 * lived in this process, the runtime intermittently stops reaping children —
 * ffmpeg finishes but execFile's promise never resolves. runProcess decides
 * completion itself, so a hung reaper can't stall a render. */
async function run(
  bin: string,
  args: string[],
  timeoutMs = 10 * 60 * 1000
): Promise<string> {
  const { stdout, stderr } = await runProcess(bin, args, { timeoutMs });
  return stdout || stderr;
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

// ---------- Ken Burns (Smart Motion) ----------
// The camera plans and the ffmpeg graph live in motion.ts — the reusable,
// unit-tested Smart Motion module. render.ts only orchestrates.

// ---------- Animated (CogVideoX i2v) ----------

/**
 * Generate (or reuse a cached) 5s animated clip for one scene via
 * CogVideoX image-to-video, seeded from the storyboard image.
 *
 * S35 — the motion prompt is plan-aware (i2vMotionPrompt in liveliness.ts):
 * an approved Director camera (crane-up, handheld, drone…) drives the
 * generation instead of the old five-id map that degraded everything else
 * to generic drift, and a per-scene-kind SUBJECT-motion clause names what
 * actually moves — the thing Ken Burns cannot produce.
 */
async function ensureSceneClip(
  videoId: string,
  scene: Scene,
  directorScene: DirectorScene | null
): Promise<string> {
  const clipPath = path.join(videoDir(videoId), `scene-${String(scene.index).padStart(2, "0")}.mp4`);
  if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 10_000) return clipPath;

  const imagePath = path.join(videoDir(videoId), sceneImageFile(scene.index));
  const imageB64 = fs.readFileSync(imagePath).toString("base64");

  // Video generation is Z.ai CogVideoX — validate the provider up front so
  // misconfigured installs fail with a actionable message instead of an
  // opaque SDK error deep inside the render.
  const videoConfig = await getCapability("video");
  if (videoConfig.provider !== "zai") {
    throw new Error(
      "Scene animation only supports Z.ai CogVideoX — fix it in Settings → AI Providers, or render with Ken Burns mode (no AI video needed)"
    );
  }
  const videoModel = videoConfig.model?.trim() || VIDEO_DEFAULT_MODEL;

  // S50 — the i2v motion prompt rides the content policy like every other
  // generation surface (the S49 L3 gap in the VIDEO path: the storyboard
  // image was sanitized, but the motion prompt that animates it was not —
  // a noncompliant scene.visual could steer the clip toward depicting a
  // restricted figure). sanitizePromptForPolicy is the identity under the
  // standard policy.
  const motionPrompt = sanitizePromptForPolicy(
    i2vMotionPrompt(scene, directorScene),
    await getVideoContentPolicy(videoId)
  ).prompt;

  const zai = await zaiClientFor("video");
  const clip = await aiCall(
    "video",
    `scene ${scene.index} i2v`,
    async () => {
      // S36-audit wiring — the submit/poll/download loop now lives in the
      // tested core (providers/zai-video-core.ts), shared with the provider
      // adapter; this site keeps the clip cache, the 10s×60 window and the
      // aiCall retry it always had.
      const buf = await zaiVideoViaClient(
        zai,
        {
          prompt: motionPrompt,
          imagePngBase64: imageB64,
        },
        {
          model: videoModel,
          duration: 5,
          fps: FPS,
          size: "1920x1080",
          pollMs: 10_000,
          maxPolls: 60,
        },
      );
      fs.writeFileSync(clipPath, buf);
      return clipPath;
    },
    { attempts: 2, baseDelayMs: 8000 } // one retry — these are long calls
  );

  return clip;
}

/**
 * S50 — a seamless loop source for clips shorter than their scene. The raw
 * `-stream_loop -1` forward loop REWINDS visibly every clip-length seconds —
 * the 5s "groundhog day" jump-cut on any longer scene (most narration scenes
 * run 8–18s). The palindrome (forward + reverse) never rewinds: its only
 * artifacts are single duplicated frames at the two turning points (33 ms at
 * 30 fps — imperceptible), and looping the palindrome crosses the boundary
 * with a 1-frame step. Cached beside the clip; built once per clip.
 */
async function ensureSceneLoop(clipPath: string, fps: number): Promise<string> {
  const loopPath = clipPath.replace(/(\.\w+)$/, "-loop.mp4");
  if (fs.existsSync(loopPath) && fs.statSync(loopPath).size > 10_000) return loopPath;
  await run("ffmpeg", [
    "-i", clipPath,
    "-filter_complex", PALINDROME_LOOP_GRAPH,
    "-map", "[v]",
    "-r", String(fps),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-an", "-y", loopPath,
  ]);
  return loopPath;
}

// ---------- Per-niche music beds ----------

/**
 * A synthesized ambient bed profile. Each niche gets its own tonal center,
 * interval stack, breathing rate and filter so a Motivation video doesn't
 * sound like a Mysteries one. All beds are slow evolving pads — they sit
 * UNDER narration (ducked later) and must never carry a melody or rhythm
 * that competes with the voice.
 */
interface MusicProfile {
  /** Stacked sine partials (Hz) with relative gains — root + color intervals. */
  partials: [freq: number, gain: number][];
  /** Breathing LFO rate (Hz) + depth (0-1) — how much the pad swells. */
  lfoRate: number;
  lfoDepth: number;
  /** Lowpass ceiling (Hz) — lower = darker, further from the voice band. */
  lowpassHz: number;
  /** Bed gain before ducking. */
  level: number;
}

const MUSIC_PROFILES: Record<string, MusicProfile> = {
  // Warm uplifting A-minor stack with a slow sunrise swell.
  Motivation: {
    partials: [[55, 0.05], [110.4, 0.034], [164.8, 0.02], [220.5, 0.012]],
    lfoRate: 0.07, lfoDepth: 0.22, lowpassHz: 1000, level: 1.0,
  },
  // Light, curious C-major-ish stack, a touch brighter and quicker.
  "Fun Facts": {
    partials: [[65.4, 0.05], [130.8, 0.032], [196.2, 0.022], [261.8, 0.011]],
    lfoRate: 0.11, lfoDepth: 0.18, lowpassHz: 1200, level: 0.95,
  },
  // Solemn epic D — low, wide, slowest breathing in the catalog.
  History: {
    partials: [[36.7, 0.055], [73.4, 0.036], [110.2, 0.02], [146.9, 0.012]],
    lfoRate: 0.05, lfoDepth: 0.26, lowpassHz: 850, level: 1.0,
  },
  // Cold minimal G — sparse, steady, businesslike.
  Finance: {
    partials: [[49.0, 0.05], [98.1, 0.03], [147.0, 0.018]],
    lfoRate: 0.06, lfoDepth: 0.14, lowpassHz: 800, level: 0.9,
  },
  // Introspective E — soft, round, slightly airy.
  Psychology: {
    partials: [[41.2, 0.05], [82.4, 0.033], [123.5, 0.02], [164.8, 0.01]],
    lfoRate: 0.08, lfoDepth: 0.2, lowpassHz: 950, level: 0.95,
  },
  // Vast airy A fifth — space, orbital, weightless.
  "Space & Science": {
    partials: [[55.0, 0.05], [82.5, 0.03], [110.0, 0.022], [165.2, 0.01]],
    lfoRate: 0.06, lfoDepth: 0.24, lowpassHz: 1100, level: 1.0,
  },
  // Clean neutral F fifth — precise, digital, unobtrusive.
  Technology: {
    partials: [[58.3, 0.05], [116.6, 0.03], [174.7, 0.018]],
    lfoRate: 0.09, lfoDepth: 0.15, lowpassHz: 1150, level: 0.9,
  },
  // Dark F#-C tension — unease without ever becoming a jump-scare.
  Mysteries: {
    partials: [[46.2, 0.05], [69.3, 0.034], [92.6, 0.02], [139.0, 0.012]],
    lfoRate: 0.045, lfoDepth: 0.28, lowpassHz: 780, level: 1.0,
  },
};

const DEFAULT_MUSIC_PROFILE: MusicProfile = MUSIC_PROFILES.Motivation;

/** Pick the ambient bed for a video niche (unknown niches get the default). */
export function musicProfileForNiche(niche: string | undefined | null): MusicProfile {
  return (niche && MUSIC_PROFILES[niche]) || DEFAULT_MUSIC_PROFILE;
}

/** Build the aevalsrc expression for a profile's breathing pad. */
export function droneSource(profile: MusicProfile): string {
  const tones = profile.partials
    .map(([f, g]) => `${g.toFixed(4)}*sin(2*PI*${f}*t)`)
    .join("+");
  const breath = `(1-${profile.lfoDepth.toFixed(2)}+${profile.lfoDepth.toFixed(2)}*sin(2*PI*${profile.lfoRate}*t))`;
  return `aevalsrc='(${tones})*${breath}':s=48000`;
}

// ---------- Segments & assembly ----------

/** M2 — project a SceneShotPlan onto concrete ffmpeg shot inputs. Images that
 *  went missing between generation and composition (cleaned scratch dir,
 *  interrupted re-render) demote to pseudo crops over the scene art — the
 *  render always receives a full shot list (spec §1.8 floor). S48: the
 *  per-shot focal anchor + moveSpeed multiplier ride through verbatim. S50:
 *  the hand-off rides too (transitionOut → the shot graph's xfade). */
function resolveShotInputs(
  dir: string,
  plan: SceneShotPlan,
  sceneImg: string
): { file: string; moveKind: MoveKind; sec: number; crop?: { w: number; h: number; x: number; y: number }; focal?: { x: number; y: number }; speed?: number; transitionOut?: string }[] {
  const out: {
    file: string;
    moveKind: MoveKind;
    sec: number;
    crop?: { w: number; h: number; x: number; y: number };
    focal?: { x: number; y: number };
    speed?: number;
    transitionOut?: string;
  }[] = [];
  for (const sh of plan.available) {
    const file = path.join(dir, sh.imageFile);
    if (sh.source === "scene" || fs.existsSync(file)) {
      out.push({ file, moveKind: sh.moveKind, sec: sh.sec, crop: sh.crop, focal: sh.focal, speed: sh.speed, transitionOut: sh.transitionOut });
      continue;
    }
    out.push({
      file: sceneImg,
      moveKind: sh.moveKind,
      sec: sh.sec,
      crop: sh.crop ?? PSEUDO_CROPS[sh.shotIndex % PSEUDO_CROPS.length],
      focal: sh.focal,
      speed: sh.speed,
      transitionOut: sh.transitionOut,
    });
  }
  return out;
}

/** Build one scene segment: visual track of exactly `dur` + narration audio
 * (+ SFX cue + director-planned ambience bed). */
async function buildSegment(opts: {
  videoId: string;
  scene: Scene;
  dur: number;
  mode: "kenburns" | "animated" | "stock" | "slides";
  motion: MotionSettings;
  plan?: MotionScenePlan;
  sfx: boolean;
  /** S5 — the RESOLVED sound pick for this scene: the timeline doc's studio
   *  pick outranks the plan's cue, which outranks the story pass's row value
   *  (resolveSoundChoice at the call site — the one precedence rule). */
  sfxKind?: string;
  /** Module E: materialized ambience bed path for this scene (null = none). */
  ambiencePath?: string | null;
  /** S2: per-scene mix levels from the timeline doc (null = classic mix). */
  docLevels?: SceneAudioLevels | null;
  /** S2 wave 2 — per-scene creative layer. All optional (null = classic). */
  docGrade?: SceneGrade | null;
  docTitle?: SceneTitle | null;
  docCamera?: SceneCameraKeys | null;
  docSpeed?: number | null;
  /** S2 wave 2 — narration fades (sanitized) + the measured WAV length the
   *  fade-out anchors to. */
  docFades?: { inSec: number; outSec: number } | null;
  wavDur?: number;
  /** S3 — chroma key settings for this scene (null = none; slides never key). */
  docChroma?: SceneChroma | null;
  /** S3 — corner logo overlay settings (null = none; requires a brand logo). */
  docPip?: ScenePip | null;
  /** S3 — encode quality tier (default "standard": CRF 20 / veryfast). */
  quality?: ExportQuality;
  /** M2: the approved Director shot list for this scene — when present, the
   * scene renders through the multi-image shot graph instead of the single-
   * image Smart Motion graph (docs/director-m1-m2-spec.md §1.7). */
  shotPlan?: SceneShotPlan;
  outPath: string;
  /** Stage 6 (T-6.8) — per-render aspect ratio (default "16:9"). */
  aspect?: "16:9" | "9:16" | "1:1";
  /** Stage 6 (T-6.8) — per-render frame rate (default 30). */
  fps?: number;
  /** S35 — the liveliness selector's per-scene channel. Absent → the mode's
   *  own default, so any caller that doesn't know about the selector keeps
   *  its exact pre-S35 behavior. */
  channel?: LivelinessChannel;
  /** S35 — the scene's approved Director row (drives the i2v motion prompt). */
  directorScene?: DirectorScene | null;
  /** S35 — fired when the i2v channel degrades to Ken Burns (per-scene picks
   *  never break the render; the orchestrator turns this into a progress
   *  note so the degradation is VISIBLE, never silent). */
  onI2vFallback?: (sceneIndex: number, reason: string) => void;
  /** S55 (T-55.3a) — fired when the scene renders through the M2 multi-shot
   *  graph, with the joins that ACTUALLY executed (scene-local clock — the
   *  same fitted allocation the graph runs). The orchestrator books them
   * into RenderResult.expectedCuts so the QC cut-alignment lens reads the
   *  graph's own flips as designed boundaries, not strays. */
  onShotJoins?: (joins: ShotJoinMark[]) => void;
}): Promise<void> {
  const { scene, dur, mode, motion, plan, shotPlan, outPath } = opts;
  const dir = videoDir(opts.videoId);
  const wav = path.join(dir, sceneWavFile(scene.index));
  const leadMs = Math.round(LEAD_SEC * 1000);
  const aspect = opts.aspect ?? "16:9";
  const fps = opts.fps ?? FPS;
  // S2 wave 2 — the per-scene creative layer resolves ONCE: the grade (the
  // classic look is the default), the title overlay chain (null = none) and
  // the footage playback rate (1 = no setpts).
  const grade = gradeForScene(opts.docGrade);
  // S3 — keying + corner overlay. Slides keep their designed-deck grammar
  // (no grade, no keying, no overlay — the brand kit owns the logo there).
  const chroma = mode !== "slides" ? opts.docChroma ?? null : null;
  const pip = mode !== "slides" ? opts.docPip ?? null : null;
  // The logo is a storage object — materialize to a local path for ffmpeg.
  // SVGs can't be read by this build; the overlay is skipped with a note.
  let pipLogoPath: string | null = null;
  if (pip) {
    for (const ext of ["png", "webp"]) {
      const key = `${opts.videoId}/brand-logo.${ext}`;
      if (await storage.exists(key)) {
        pipLogoPath = await storage.materialize(key);
        break;
      }
    }
    if (!pipLogoPath)
      renderLog.warn("PIP set but no png/webp brand logo — overlay skipped", { scene: scene.index });
  }
  const speed =
    opts.docSpeed && opts.docSpeed > 0.49 && opts.docSpeed < 2.01 && Math.abs(opts.docSpeed - 1) > 0.02
      ? opts.docSpeed
      : null;
  // S3 post-base chain: chroma → PIP → title, chained onto the base graph's
  // [v] tail. Chroma keys PRE-grade (a graded key color would poison the
  // key) and re-applies the grade to the composite; the title then consumes
  // the chain's tail label.
  const [W, H] = OUTPUT_SIZES[aspect].out;
  const postParts: string[] = [];
  let tail = "[v]";
  if (chroma) {
    const c = chromaFilterChain(chroma, { w: W, h: H, dur, fps, grade });
    postParts.push(c.chain);
    tail = c.outLabel;
  }
  const hasPip = pip != null && pipLogoPath != null;
  const pipChainFor = (idx: number): string =>
    hasPip && pip && pipLogoPath
      ? pipOverlayFilter(pip, { pipInput: idx, frameW: W, frameH: H, inLabel: tail }).chain
      : "";
  if (hasPip) tail = "[vp]";
  const titleChain = titleDrawtextFilter(opts.docTitle ?? null, dur, aspect !== "16:9", tail);
  // vMap follows the chain's tail so input order and labels can never drift.
  const vMap = titleChain ? "[vt]" : tail;
  const fullVisual = (base: string, pipIdx: number | null): string => {
    const parts = [base, ...postParts];
    if (pipIdx != null && hasPip) parts.push(pipChainFor(pipIdx));
    if (titleChain) parts.push(titleChain);
    return parts.join(";");
  };
  const pipInputs = hasPip && pipLogoPath
    ? ["-loop", "1", "-framerate", String(fps), "-t", (dur + 0.5).toFixed(3), "-i", pipLogoPath]
    : [];
  const visualSuffix = (inputLabel: string): string => {
    // Stock/animated footage: the doc's playback rate is a setpts on the
    // clip itself (the loop covers the shorter effective length). With a
    // chroma key the grade moves AFTER the composite (keying sees raw art).
    const speedLead = speed ? `setpts=PTS/${speed.toFixed(4)},` : "";
    const inner = [speedLead, chroma ? "" : grade].filter(Boolean).join("");
    return `[${inputLabel}:v]${inner || "null"}[v]`;
  };
  const FOOTAGE = "0"; // the clip's input index in both footage paths
  const quality = QUALITY_ENCODING[opts.quality ?? "standard"];
  // One helper owns BOTH the extra audio inputs and the graph, so input
  // order and stream labels can never drift apart.
  const audio = await sceneAudio(
    opts.sfx,
    opts.sfxKind ?? scene.sfx,
    opts.ambiencePath ?? null,
    leadMs,
    dur,
    opts.docLevels ?? null,
    // S2 wave 2 — narration pace: the doc's playback rate + voice fades,
    // anchored to the measured WAV length (probed once per render).
    opts.docSpeed || opts.docFades
      ? {
          speed: speed,
          wavDur: opts.wavDur ?? 0,
          fades: opts.docFades ?? null,
        }
      : undefined
  );

  const common = [
    "-map", vMap, "-map", "[a]",
    "-t", dur.toFixed(3),
    "-r", String(fps),
    "-c:v", "libx264", "-preset", quality.preset, "-crf", quality.crf,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    "-y", outPath,
  ];

  // Keynote slides: the designed PNG IS the frame — 9:16 geometry, the
  // pipeline's finishing grade would only muddy its tuned palette. The still
  // enters ONCE and zoompan emits the shot (no looped-image demuxer — large
  // looped PNGs deadlock this ffmpeg build's teardown).
  if (mode === "slides") {
    const slidePath = slidePngPath(opts.videoId, scene.index);
    if (!fs.existsSync(slidePath))
      throw new Error(`Scene ${scene.index} has no slide image — the slide deck step was skipped`);
    const vChain = slideSegmentGraph({
      dur,
      plan:
        plan ?? {
          sceneType: "standard",
          move: "Static hold",
          shots: [{ kind: "hold", zStart: 1, zEnd: 1, focal: { x: 0.5, y: 0.5 }, travel: 0, sec: 99 }],
          staticImage: true,
        },
      settings: motion,
      fps,
    });
    const aChain = audio.graph;
    await run("ffmpeg", [
      "-i", slidePath,
      "-i", wav,
      ...audio.inputs,
      "-filter_complex", `${vChain};${aChain}`,
      ...common,
    ]);
    return;
  }
  if (mode === "stock") {
    // Hybrid: matched stock footage when the scene has a clip on disk,
    // otherwise fall through to the art path below. (S35: the selector only
    // names "stock" when the clip exists — this fs guard is belt-and-braces.)
    const clip = scene.stock
      ? path.join(dir, scene.stock.file)
      : null;
    if (clip && fs.existsSync(clip)) {
      await run("ffmpeg", [
        "-stream_loop", "-1", "-t", dur.toFixed(3), "-i", clip,
        "-i", wav,
        ...audio.inputs,
        ...pipInputs,
        "-filter_complex", `${fullVisual(visualSuffix(FOOTAGE), hasPip ? 2 + audio.inputs.filter((a) => a === "-i").length : null)};${audio.graph}`,
        ...common,
      ]);
      return;
    }
  }

  // S35 — the scene's execution channel: the selector's verdict, or the
  // mode's own default for callers that predate the selector. (Slides and
  // animated callers that bypass the selector: slides already returned above;
  // animated maps to i2v — the pre-S35 behavior, unchanged.)
  const chan: LivelinessChannel = opts.channel ?? (mode === "animated" ? "i2v" : mode);

  // S35 — the Ken Burns executor (the M2 multi-shot Director graph, or the
  // single-image Smart Motion graph), extracted so an i2v scene that cannot
  // produce its clip degrades HERE — the liveliness pick never breaks the
  // render, it just plays the next-liveliest channel.
  const runKenburns = async (): Promise<void> => {
    const img = path.join(dir, sceneImageFile(scene.index));

    // M2 — the approved Director shot list drives the scene (spec §1.7):
    // per-shot image (scene art / fresh AI render / pseudo crop), per-shot
    // camera move, per-shot reconciled duration. motion.ts stays the ONLY
    // zoompan math engine (multiShotSceneGraph → shotZoompan). The scene-
    // level motion-map override does NOT apply here — per-shot Director
    // decisions are senior; it keeps governing plan-less scenes (§1.3).
    const shotInputs = shotPlan?.available?.length
      ? resolveShotInputs(dir, shotPlan, img)
      : null;
    if (shotInputs) {
      const audioInputCount = audio.inputs.filter((a) => a === "-i").length;
      const inputFor = new Map<string, number>([[img, 0]]);
      const extraInputs: string[] = [];
      // Input order: 0 = scene image, 1 = narration, 2.. = audio extras,
      // then one still input per distinct shot image. The +1s of slack is
      // free — each branch trims to its exact frame count, the pad only
      // guarantees a stream never ends before its trim point.
      let nextInput = 2 + audioInputCount;
      // Get-once: assign each distinct shot image its input index as the
      // list is walked — first sighting claims the next index AND pushes the
      // still input; later sightings reuse it. Order is identical to the
      // old two-pass loop, so indices cannot drift.
      const shotList = shotInputs.map((sh) => {
        let input = inputFor.get(sh.file);
        if (input === undefined) {
          input = nextInput++;
          inputFor.set(sh.file, input);
          extraInputs.push(
            "-loop", "1", "-framerate", String(fps), "-t", (sh.sec + 1).toFixed(3), "-i", sh.file
          );
        }
        return {
          kind: sh.moveKind,
          sec: sh.sec,
          input,
          crop: sh.crop,
          focal: sh.focal,
          speed: sh.speed,
          transitionOut: sh.transitionOut,
        };
      });
      const vChain = multiShotSceneGraph({
        dur,
        settings: motion,
        fps,
        aspect,
        grade: chroma ? "" : grade,
        focal: focalForScene(scene),
        shots: shotList,
      });
      // S55 (T-55.3a) — record the graph's own boundaries (the SAME fitted
      // allocation the graph just executed) for the render→QC contract.
      opts.onShotJoins?.(shotGraphJoins({ dur, shots: shotList, fps }));
      // The PIP logo rides AFTER the shot stills (input order: 0 = scene
      // image, 1 = narration, 2.. = audio extras, then stills, then logo —
      // the index is positional, nextInput counts it).
      if (hasPip) extraInputs.push(...pipInputs);
      const pipIdxShot = hasPip ? nextInput : null;
      await run("ffmpeg", [
        "-loop", "1", "-framerate", String(fps), "-t", dur.toFixed(3), "-i", img,
        "-i", wav,
        ...audio.inputs,
        ...extraInputs,
        "-filter_complex", `${fullVisual(vChain, pipIdxShot)};${audio.graph}`,
        ...common,
      ]);
      return;
    }

    // Smart Motion: scene-aware plan (from motion.ts) -> ffmpeg filter graph.
    const vChain = sceneFilterGraph({
      dur,
      plan: plan ?? { sceneType: "standard", move: "Static hold", shots: [{ kind: "hold", zStart: 1, zEnd: 1, focal: { x: 0.5, y: 0.5 }, travel: 0, sec: 99 }], staticImage: true },
      settings: motion,
      fps,
      aspect,
      grade: chroma ? "" : grade,
    });
    await run("ffmpeg", [
      "-loop", "1", "-framerate", String(fps), "-t", dur.toFixed(3), "-i", img,
      "-i", wav,
      ...audio.inputs,
      ...pipInputs,
      "-filter_complex", `${fullVisual(vChain, hasPip ? 2 + audio.inputs.filter((a) => a === "-i").length : null)};${audio.graph}`,
      ...common,
    ]);
  };

  // S35 — the i2v channel: subject-real motion for the scenes the approved
  // plan (or the video-level animated pick) sent here. The generation rides
  // aiCall("video") — metered under the $5 gate like every other dispatch.
  if (chan === "i2v") {
    try {
      const clip = await ensureSceneClip(opts.videoId, scene, opts.directorScene ?? null);
      // S50 — scenes longer than the generated clip loop a PALINDROME
      // (forward + reverse) instead of the raw forward loop's visible
      // rewind every clip-length seconds. Clips shorter than the scene keep
      // their exact file (byte-identical legacy path).
      let loopSrc = clip;
      try {
        const clipDur = await probeDuration(clip);
        if (dur > clipDur - 0.2) loopSrc = await ensureSceneLoop(clip, fps);
      } catch {
        // A probe/palindrome failure never fails the render — the raw loop
        // is the pre-S50 behavior and still plays.
      }
      await run("ffmpeg", [
        "-stream_loop", "-1", "-t", dur.toFixed(3), "-i", loopSrc,
        "-i", wav,
        ...audio.inputs,
        ...pipInputs,
        "-filter_complex", `${fullVisual(visualSuffix(FOOTAGE), hasPip ? 2 + audio.inputs.filter((a) => a === "-i").length : null)};${audio.graph}`,
        ...common,
      ]);
      return;
    } catch (err) {
      // Honest degradation, two contracts:
      //  • video-level "animated": the user asked for FULL animation — a
      //    failed clip fails the render (a silently different product would
      //    be a lie). Pre-S35 behavior, unchanged.
      //  • per-scene liveliness picks (the Director's needsI2V): the render
      //    falls back to the Ken Burns executor and the orchestrator reports
      //    the fallback — visible, never silent.
      if (mode === "animated") throw err;
      opts.onI2vFallback?.(
        scene.index,
        err instanceof Error ? err.message : String(err).slice(0, 160)
      );
      await runKenburns();
      return;
    }
  }

  await runKenburns();
}

/** Per-scene audio levels for one segment's graph (S2 — from the timeline
 *  doc's edited projection; defaults preserve the pre-S2 mix exactly). */
export interface SceneAudioLevels {
  voice: number; // narration gain, 0..1 (1 = full)
  sfx: number; // SFX cue weight (amix weight, 0 = skip the cue)
  ambient: number; // ambience bed weight (amix weight, 0 = skip the bed)
}

const SCENE_AUDIO_DEFAULTS: SceneAudioLevels = { voice: 1, sfx: 0.35, ambient: 0.1 };

/** Clamp a doc level into the graph's legal range. */
function clampLevel(v: number | null | undefined, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 1);
}

/**
 * Audio inputs + graph for one scene, built together so input order and
 * stream labels can never drift apart:
 *   [1:a] narration, delayed to its lead-in, padded to the scene length;
 *   [2:a] the scene's SFX cue fired 40 ms after the cut (when enabled);
 *   [3:a] the director-planned ambience bed, looped for the scene and riding
 *         well under the voice (module E).
 * `sfx` = false (Settings → Sound) silences every synthesized extra — cues
 * AND beds — for the render. The voice pad is FINITE (apad whole_dur) — every
 * stream in the graph then ends on its own, so ffmpeg always tears down
 * cleanly. normalize=0 keeps the amix weights as literal gains (default
 * normalization would scale every source down by 1/Σw).
 *
 * S2: `levels` (from the timeline doc) scales the narration and REPLACES the
 * historic cue/bed weights — the studio's inspector sliders are the mix now.
 * A zero level drops the cue/bed input entirely (cheaper than mixing silence)
 * but the narration chain always stays: apad on [voice] is the amix's
 * duration anchor, so the segment's length never depends on the extras.
 */
export async function sceneAudio(
  sfx: boolean,
  sfxKind: string,
  ambiencePath: string | null,
  leadMs: number,
  totalSec: number,
  levels?: SceneAudioLevels | null,
  pace?: {
    /** S2 wave 2 — per-scene playback rate (0.5..2, null = normal). Applied
     *  to the narration as atempo BEFORE the fades (a compressed read ends
     *  earlier; the fade-out must chase the compressed end). */
    speed: number | null;
    /** The scene WAV's measured length — the fade-out anchors to the
     *  narration's real end (compressed), never the padded window. */
    wavDur: number;
    /** Narration fade in/out (seconds), sanitized by studio-doc. */
    fades: { inSec: number; outSec: number } | null;
  }
): Promise<{ inputs: string[]; graph: string }> {
  const lv = levels
    ? {
        voice: clampLevel(levels.voice, SCENE_AUDIO_DEFAULTS.voice),
        sfx: clampLevel(levels.sfx, SCENE_AUDIO_DEFAULTS.sfx),
        ambient: clampLevel(levels.ambient, SCENE_AUDIO_DEFAULTS.ambient),
      }
    : SCENE_AUDIO_DEFAULTS;
  const voiceGain = Math.abs(lv.voice - 1) < 0.001 ? "" : `,volume=${lv.voice.toFixed(3)}`;
  // S2 wave 2 — pace the narration: atempo compresses/stretches the read
  // (pitch-preserving, no words lost), afade shapes its head/tail. The fade
  // out anchors to the COMPRESSED end (wavDur/speed) so a sped-up read fades
  // where it actually stops, not where the original would have.
  let voiceHead = "[1:a]";
  if (pace?.speed) voiceHead += `atempo=${pace.speed.toFixed(4)},`;
  if (pace?.fades) {
    const { inSec, outSec } = pace.fades;
    const compressed = pace.wavDur / (pace.speed ?? 1);
    if (inSec >= 0.02) voiceHead += `afade=t=in:st=0:d=${Math.min(inSec, compressed).toFixed(3)},`;
    if (outSec >= 0.02) {
      const st = Math.max(0, compressed - outSec).toFixed(3);
      voiceHead += `afade=t=out:st=${st}:d=${outSec.toFixed(3)},`;
    }
  }
  const voice = `${voiceHead}adelay=${leadMs}:all=1,apad=whole_dur=${totalSec.toFixed(3)}${voiceGain}[voice]`;
  // SFX lands 40 ms after the cut so the impact sits with the first frame,
  // not in the file's leading edge; the doc's per-scene level is the mix
  // weight (0.35 classic default; the assembly seeds boom=0.55, riser=0.4,
  // sting=0.45 — the render now honors those too). The ambience bed rides
  // lower (0.10 classic): synthesized noise beds any louder read as hiss.
  const sfxPath = sfx && lv.sfx > 0.001 ? await ensureSfx(sfxKind) : null;
  const ambPath = sfx && lv.ambient > 0.001 ? ambiencePath : null; // one switch, every synthesized extra
  if (!sfxPath && !ambPath) return { inputs: [], graph: `${voice};[voice]anull[a]` };

  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  const weights: string[] = ["1"];
  let idx = 2;
  if (sfxPath) {
    inputs.push("-i", sfxPath);
    chains.push(`[${idx}:a]adelay=40:all=1[sfx]`);
    labels.push("[sfx]");
    weights.push(lv.sfx.toFixed(3));
    idx++;
  }
  if (ambPath) {
    inputs.push("-stream_loop", "-1", "-t", totalSec.toFixed(3), "-i", ambPath);
    // The bed's own highpass stays; its MIX WEIGHT is the doc's level.
    chains.push(`[${idx}:a]volume=0.85,highpass=f=120[amb]`);
    labels.push("[amb]");
    weights.push(lv.ambient.toFixed(3));
  }
  return {
    inputs,
    graph:
      `${voice};${chains.join(";")};` +
      `${["[voice]", ...labels].join("")}amix=inputs=${labels.length + 1}:duration=first:normalize=0:weights='${weights.join(" ")}'[a]`,
  };
}

/** Concat segment files (identical codecs) into one MP4. */
async function concatSegments(segPaths: string[], outPath: string): Promise<void> {
  const listFile = outPath.replace(/\.mp4$/, "-list.txt");
  fs.writeFileSync(listFile, segPaths.map((p) => `file '${p}'`).join("\n") + "\n");
  await run("ffmpeg", ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-y", outPath]);
  fs.rmSync(listFile, { force: true });
}

/**
 * Blend ONE run of ≥2 segments (no "cut" inside) into `outPath`, honoring
 * each boundary's own style + duration. Memory-bounded grouping: a full
 * N-input xfade chain buffers frames for every not-yet-consumed input —
 * measured at 2.4–3.1 GB RSS for 12×1080p inputs, which the kernel
 * OOM-kills in a 4 GB container — so blending runs in bounded GROUPS
 * (planBlendGroupsMulti, ≤groupMax inputs per ffmpeg pass), then blends the
 * group outputs, recursing until one master remains. Group intermediates
 * re-encode at crf 16 (near-transparent) so at most one extra generation
 * touches any frame before the final join.
 *
 * Between rounds, the boundary settings CARRY OVER: the next round's inputs
 * are the group outputs, and the boundary between group k and k+1 is the
 * original boundary at segment groups[k].to — so a per-scene transition
 * survives regrouping exactly.
 */
async function blendRun(
  segPaths: string[],
  durationsSec: number[],
  settings: TransitionSettings[],
  outPath: string,
  groupMax: number,
  quality: { crf: string; preset: string } = QUALITY_ENCODING.standard
): Promise<void> {
  const tmp = (i: number, round: number) =>
    outPath.replace(/\.mp4$/, `.blend-r${round}-${i}.mp4`);

  // Round 0 inputs are the real segments; later rounds blend group outputs.
  let round = 0;
  let paths = segPaths.slice();
  let durations = durationsSec.slice();
  let boundaries = settings.slice();

  while (paths.length > 1) {
    const groups = planBlendGroupsMulti(durations, boundaries, groupMax);
    const nextPaths: string[] = [];
    const nextDurations: number[] = [];
    const nextBoundaries: TransitionSettings[] = [];
    const singlePass = groups.length === 1 && groups[0].to - groups[0].from + 1 === paths.length;

    for (const [gi, g] of groups.entries()) {
      const groupPaths = paths.slice(g.from, g.to + 1);
      const groupDurations = durations.slice(g.from, g.to + 1);
      if (groupPaths.length === 1) {
        // Pass-through: no blend needed inside a lone segment group.
        nextPaths.push(groupPaths[0]);
        nextDurations.push(groupDurations[0]);
      } else {
        // Internal boundaries only (from..to−1) — the group's outer seams
        // belong to the NEXT round, between group outputs.
        const groupSettings = boundaries.slice(g.from, g.to);
        const graph = buildTransitionGraphMulti(groupDurations, groupSettings);
        if (!graph) throw new Error("blend group too small for xfade");
        // The last group of the last round writes the real output; every other
        // pass writes a near-lossless intermediate.
        const isFinal = singlePass && gi === groups.length - 1;
        const groupOut = isFinal ? outPath : tmp(gi, round);
        const args: string[] = [];
        for (const p of groupPaths) args.push("-i", p);
        args.push(
          "-filter_complex", `${graph.video};${graph.audio}`,
          "-map", "[v]", "-map", "[a]",
          // Intermediates at crf 16 (near-transparent) — only the final master
          // uses the delivery quality the downstream passes expect.
          "-c:v", "libx264", "-preset", isFinal ? quality.preset : "veryfast", "-crf", isFinal ? quality.crf : "16",
          "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", isFinal ? "160k" : "256k",
          "-ar", "48000", "-ac", "2",
          "-y", groupOut
        );
        await run("ffmpeg", args);
        // Verify the pass actually wrote a playable file. An OOM-killed ffmpeg
        // resolves "successfully" through the zombie poll (its stderr carries no
        // failure signature — just truncated progress lines), leaving a file
        // without a moov atom that fails HERE instead of in the next round with
        // a confusing message about the wrong file.
        try {
          await probeDuration(groupOut);
        } catch {
          throw new Error(
            `Blend pass ${round}.${gi} (${groupPaths.length} inputs) wrote an unreadable file — the machine most likely ran out of memory mid-encode. Free RAM or retry; small-RAM hosts automatically use lighter blend groups.`
          );
        }
        nextPaths.push(groupOut);
        nextDurations.push(g.outDurationSec);
      }
      // The boundary AFTER this group becomes a next-round boundary (the
      // last group has none — its tail is the run's end).
      if (gi < groups.length - 1) nextBoundaries.push(boundaries[g.to]);
    }

    // Clean up the consumed intermediates. A singleton group passes its
    // segment through UNTOUCHED into nextPaths — deleting every previous
    // round file would destroy it before the next round reads it (this
    // fires with a small group cap: 3 inputs → groups of 2 + 1). Anything
    // still referenced by the next round must survive.
    if (round > 0) {
      const stillNeeded = new Set(nextPaths);
      for (const p of paths) {
        if (!stillNeeded.has(p)) fs.rmSync(p, { force: true });
      }
    }

    paths = nextPaths;
    durations = nextDurations;
    boundaries = nextBoundaries;
    round++;
  }

  // Single-segment survivor (every round pass-through): the segment IS the
  // run's output.
  if (paths.length === 1 && paths[0] !== outPath) {
    fs.copyFileSync(paths[0], outPath);
  }
}

/**
 * Stitch segments with the timeline doc's PER-BOUNDARY transitions (S2):
 * each seam blends with its own style + duration; "cut" seams are STITCH
 * points, not blends. All-cut (or single-segment) renders take the classic
 * stream-copy concat; a video with no cuts blends in one run (the classic
 * behavior, now per-boundary); a MIXED doc partitions at the cuts — each
 * run blends internally (memory-bounded, per-boundary), then the runs join
 * with the stream-copy concat, so a hard cut lands exactly where the doc
 * says and costs no re-encode.
 */
async function stitchSegments(opts: {
  segPaths: string[];
  durationsSec: number[];
  /** One sanitized {style, durationSec} per boundary (N−1 for N segments). */
  settings: TransitionSettings[];
  outPath: string;
  /** S3 — delivery encode tier for blend masters (default standard). */
  quality?: { crf: string; preset: string };
}): Promise<void> {
  const n = opts.segPaths.length;
  const boundaries = opts.settings.slice(0, Math.max(0, n - 1));
  const q = opts.quality ?? QUALITY_ENCODING.standard;
  if (n < 2 || boundaries.length === 0 || boundaries.every((s) => s.style === "cut")) {
    await concatSegments(opts.segPaths, opts.outPath);
    return;
  }

  // Memory-scaled group cap: the default cap of 4 was measured ~1 GB peak RSS
  // on the reference VM. On smaller hosts (≤6 GB total, e.g. a 4 GB sandbox
  // or small VPS) drop to 2 — an OOM-killed pass resolves via the zombie
  // poll with a truncated intermediate, and the next round then dies with
  // the cryptic "moov atom not found" instead of the real cause.
  const groupMax = os.totalmem() <= 6 * 1024 * 1024 * 1024 ? 2 : BLEND_GROUP_MAX;

  const runs = partitionByCuts(n, boundaries);

  // No cuts at all → one run covers everything → today's single-master path.
  if (runs.length === 1) {
    await blendRun(opts.segPaths, opts.durationsSec, boundaries, opts.outPath, groupMax, q);
    return;
  }

  // Mixed cuts + blends: blend each run into its own master (delivery
  // quality — the concat copies these streams untouched), then join at the cuts.
  const runOutputs: string[] = [];
  for (const [ri, run] of runs.entries()) {
    const paths = opts.segPaths.slice(run.from, run.to + 1);
    if (paths.length === 1) {
      runOutputs.push(paths[0]); // a lone segment between cuts passes through
      continue;
    }
    const runOut = opts.outPath.replace(/\.mp4$/, `.run${ri}.mp4`);
    await blendRun(
      paths,
      opts.durationsSec.slice(run.from, run.to + 1),
      boundaries.slice(run.from, run.to),
      runOut,
      groupMax,
      q
    );
    runOutputs.push(runOut);
  }
  await concatSegments(runOutputs, opts.outPath);
  // The .runN.mp4 masters are fully consumed by the concat.
  for (const p of runOutputs) {
    if (/\.run\d+\.mp4$/.test(p)) fs.rmSync(p, { force: true });
  }
}

/**
 * Final pass — burn subtitles and lay the ducked music bed under the
 * narration, ALWAYS loudness-normalized to the delivery targets.
 *
 * Three stages (audiomix.ts contract), fixing the -24.6 LUFS hole where a
 * narration-only render shipped raw TTS audio:
 *   A. Build the pre-normalization mix (WAV next to the base, auto-cleaned):
 *      music → voice split + ducked bed + amix; no music → measure the base
 *      audio directly.
 *   B. Measure it — one loudnorm analysis pass (I / TP / LRA / threshold).
 *   C. Normalize + finish — subtitles burn + LINEAR two-pass loudnorm
 *      (-16 LUFS, -1 dBTP) + safety limiter → AAC. Dynamic single-pass only
 *      when measurement was impossible (pure silence), so the output is
 *      never raw.
 */
async function finalize(opts: {
  base: string;
  out: string;
  burnSubtitles: boolean;
  music: boolean;
  musicNiche?: string;
  musicTrack?: ResolvedTrack | null;
  musicDuck?: DuckIntensity;
  srtPath: string | null;
  scenes: Scene[];
  segments: { start: number; duration: number }[];
  /** Caption look — vertical style for 9:16 renders (undefined = 16:9 default). */
  subtitleStyle?: string;
  /** S2 — prebuilt per-scene music-bed automation chain ([music]→[mvol],
   *  from musicLevelAutomation on the blended segments); null = plain bed. */
  musicAutomation?: string | null;
  /** S3 — delivery encode tier for the subtitle-burn pass (default standard). */
  quality?: { crf: string; preset: string };
}): Promise<void> {
  const { base, out, burnSubtitles, music } = opts;
  const workDir = path.dirname(base);

  // Library track with a readable file wins; otherwise the synthesized drone.
  const track =
    music && opts.musicTrack && fs.existsSync(opts.musicTrack.filePath)
      ? opts.musicTrack
      : null;
  const duck = sanitizeDuckIntensity(track?.duckIntensity ?? opts.musicDuck);
  const total = await probeDuration(base);

  // ---- Stage A: the pre-normalization mix ----
  const mixWav = path.join(workDir, "mix.wav");
  if (music) {
    const args: string[] = ["-i", base];
    const filters: string[] = [voiceSplitChain()];
    if (track) {
      const fadeIn = Math.min(track.fadeInSec, Math.max(total / 3, 0.2));
      const fadeOut = Math.min(track.fadeOutSec, Math.max(total / 3, 0.2));
      args.push("-stream_loop", "-1", "-i", track.filePath);
      // S2 — per-scene bed levels ride between the bed chain and the ducker
      // (the automation's [mvol] output label; without it the bed is [music]).
      const automation =
        opts.musicAutomation && /^\[music\]/.test(opts.musicAutomation) ? opts.musicAutomation : null;
      filters.push(
        bedChain({ totalSec: total, gain: track.gain, fadeInSec: fadeIn, fadeOutSec: fadeOut }),
        ...(automation ? [automation] : []),
        duckChain(duck, automation ? "mvol" : "music"),
        mixTail(1, 1)
      );
    } else {
      const profile = musicProfileForNiche(opts.musicNiche);
      args.push(
        "-f", "lavfi", "-t", total.toFixed(3), "-i", droneSource(profile)
      );
      filters.push(
        droneBedChain({ totalSec: total, lowpassHz: profile.lowpassHz, fadeInSec: 3, fadeOutSec: 4 }),
        duckChain(duck),
        mixTail(1, 0.85)
      );
    }
    await run("ffmpeg", [
      ...args,
      "-filter_complex", filters.join(";"),
      "-map", "[mix]",
      "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
      "-y", mixWav,
    ]);
  }

  // ---- Stage B: measure (the mix, or the base audio when music is off) ----
  const measured = await measureLoudness(music ? mixWav : base);

  // ---- Stage C: subtitles + normalization + encode ----
  // Subtitle burn re-encodes video through the filter graph; without a burn
  // the video is STREAM-COPIED — a `[0:v]null[v]` graph fed to `-c:v copy`
  // is illegal ffmpeg (filtering + streamcopy are mutually exclusive, and the
  // copy also saved the no-caption path a pointless full re-encode).
  const burn = burnSubtitles && Boolean(opts.srtPath);
  const q = opts.quality ?? QUALITY_ENCODING.standard;
  const stageC = burn
    ? ([
        "-filter_complex",
        `[0:v]subtitles=f='${opts.srtPath}':force_style='${opts.subtitleStyle ?? captionAssStyle(null, false)}'[v];[1:a]${normalizationFilter(measured)}[a]`,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", q.preset, "-crf", q.crf, "-pix_fmt", "yuv420p",
      ] as string[])
    : ([
        "-filter_complex", `[1:a]${normalizationFilter(measured)}[a]`,
        "-map", "0:v:0", "-map", "[a]",
        "-c:v", "copy",
      ] as string[]);

  await run(
    "ffmpeg",
    [
      "-i", base,
      "-i", music ? mixWav : base,
      ...stageC,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-movflags", "+faststart", "-y", out,
    ],
    15 * 60 * 1000
  );
  fs.rmSync(mixWav, { force: true });
}

/** Read the final or preview MP4 (or a byte range of it). */
export async function readVideoFile(
  videoId: string,
  variant: "final" | "preview"
): Promise<{ buffer: Buffer; fileName: string } | null> {
  const fileName = variant === "final" ? "final.mp4" : "preview.mp4";
  // Storage seam (T-3.7): driver-aware read.
  const s = await storage.stat(`${videoId}/${fileName}`);
  if (!s) return null;
  return { buffer: await storage.get(`${videoId}/${fileName}`), fileName };
}

/**
 * Stat the final/preview MP4 WITHOUT reading it (Stage 3, T-3.6 — D-23).
 * The streaming route opens the file lazily per Range request; memory stays
 * constant instead of one full copy per concurrent viewer.
 */
export async function statVideoFile(
  videoId: string,
  variant: "final" | "preview"
): Promise<{ key: string; size: number; fileName: string } | null> {
  const fileName = variant === "final" ? "final.mp4" : "preview.mp4";
  const key = `${videoId}/${fileName}`;
  const s = await storage.stat(key);
  if (!s) return null;
  return { key, size: s.size, fileName };
}

// ---------- Orchestrator ----------

/** Compose the video. Caller (route job) updates the DB afterwards. */
export async function renderVideo(opts: RenderOptions): Promise<RenderResult> {
  const dir = videoDir(opts.videoId);
  const scenes = opts.sceneLimit
    ? opts.scenes.slice(0, opts.sceneLimit)
    : opts.scenes;
  // S2 — the timeline doc's per-scene settings, aligned BY POSITION to the
  // scenes this render will actually cut. A doc for the FULL list is sliced
  // to the preview render's head; a doc that matches neither length is
  // dropped whole — the same all-or-nothing guard as the durations.
  const docScenes =
    opts.docScenes && opts.docScenes.length === opts.scenes.length
      ? opts.docScenes.slice(0, scenes.length)
      : opts.docScenes && opts.docScenes.length === scenes.length
        ? opts.docScenes
        : null;
  const isPreview = Boolean(opts.sceneLimit && opts.sceneLimit < opts.scenes.length);
  const outName = isPreview ? "preview.mp4" : "final.mp4";
  const outPath = path.join(dir, outName);

  if (scenes.length === 0) throw new Error("No scenes to render");

  // Validate inputs up-front with actionable messages. Slides mode does not
  // need storyboard art (the deck is designed from the script) — narration
  // timing is still mandatory in every mode.
  for (const scene of scenes) {
    if (opts.mode !== "slides" && !fs.existsSync(path.join(dir, sceneImageFile(scene.index))))
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
    const wavDurations = wavs.map(
      (d) => Math.max(d + LEAD_SEC + TAIL_SEC, MIN_SEG_SEC)
    );
    // Stage 6 (T-6.10) — when the assembled timeline supplied per-scene
    // durations, override the voiceover-derived defaults. Only honor values
    // that align to the scene list AND sit inside a sane range. A timeline
    // value may EXTEND a scene (deliberate dramatic hold, up to 3× the
    // narration) or trim its tail padding — but it can NEVER shorten a scene
    // below what its narration needs: cutting words mid-sentence is how a
    // −34 s drift video ships (Battle Yamuk: an approved director plan's
    // invented 111 s of pacing silenced the last 34 s of a 143 s narration).
    // The floor keeps narration + lead-in + a slim 0.3 s tail; the full
    // 0.85 s breathing tail may be trimmed by an editor.
    const timelineDurations = opts.sceneDurationsSec ?? [];
    const docSpeedOf = (i: number) => {
      const s = docScenes?.[i]?.speed;
      return typeof s === "number" && s >= 0.5 && s <= 2 && Math.abs(s - 1) > 0.02 ? s : 1;
    };
    const durations = wavDurations.map((d, i) => {
      const t = timelineDurations[i];
      if (typeof t !== "number" || !Number.isFinite(t)) return d;
      if (t < MIN_SEG_SEC) return d;
      // Floor: the narration must always fit (wav minus most of its tail).
      // S2 wave 2 — a doc playback rate COMPRESSES the read (atempo), so the
      // floor shrinks by the same factor: a 2× scene may be half as long.
      const sp = docSpeedOf(i);
      const narrationFloor = Math.max((d - TAIL_SEC) / sp + LEAD_SEC + 0.3, MIN_SEG_SEC);
      // Cap at 3× the measured narration so a stale timeline can't silently
      // extend a scene to minutes of dead air.
      return Math.min(Math.max(t, narrationFloor), d * 3);
    });
    const segments = durations.map((d, i) => ({
      start: durations.slice(0, i).reduce((a, b) => a + b, 0),
      duration: d,
    }));

    // Smart Motion — one camera plan per scene, sized to each scene's real
    // duration (defaults to Smart Motion on when settings are absent).
    // Stock mode: only the fallback scenes (no footage) need a camera plan.
    // Slides mode: deterministic gentle push plans (no LLM camera pass).
    const motion = sanitizeMotion(opts.motion ?? null);
    // Stage 6 (T-6.8) — the motion planner needs to know the frame geometry
    // (16:9 / 9:16 / 1:1) so it can size the camera plan to match. Slides
    // mode is always 9:16; otherwise honor opts.aspectRatio (default 16:9).
    const motionAspect: "16:9" | "9:16" | "1:1" =
      opts.mode === "slides" ? "9:16" : (opts.aspectRatio ?? "16:9");
    const motionFps = opts.frameRate ?? FPS;

    // S35 — Universal Scene Liveliness: derive ONE execution channel per
    // scene before anything else plans against the mode. The world is read
    // ONCE here (approved plan, human motion map, video provider, stock
    // files on disk, doc camera keys) and handed to the PURE selector —
    // every downstream block (camera plans, shot plans, overrides, segment
    // execution) now keys off the channel instead of re-deriving the mode
    // arithmetic inline.
    //
    // The loop this closes: the approved plan's per-scene needsI2V flag was
    // already written by the Director pass, already approved by the human,
    // and already trusted by the QC pacing gate as a motion channel — but
    // the default render mode never consumed it. Now it does: a flagged
    // scene animates (metered under the $5 gate), degrading honestly to
    // Ken Burns when no video provider is configured or the clip fails.
    const hasStock = scenes.map(
      (s) => Boolean(s.stock && fs.existsSync(path.join(dir, s.stock.file)))
    );
    // One read each — the shot-plan block and the module-D override block
    // consume the same rows instead of re-querying.
    const approvedPlan = await getApprovedPlan(opts.videoId).catch((err) => {
      renderLog.warn("director plan unavailable — liveliness falls back to Ken Burns", { err });
      return null;
    });
    const motionOverrides = await getApprovedMotionMap(opts.videoId).catch(() => new Map<number, "zoom" | "pan" | "off">());
    let i2vReady = false;
    if (opts.mode !== "slides" && opts.mode !== "animated") {
      // Only the per-scene picks need this check; animated mode doesn't ask
      // (it IS i2v — the provider error surfaces from ensureSceneClip itself,
      // as it always has) and slides/stock-with-clips never generate.
      try {
        i2vReady = (await getCapability("video")).provider === "zai";
      } catch {
        i2vReady = false; // no provider configured — honest KB fallback below
      }
    }
    const planNeedsI2V = scenes.map(
      (s) => approvedPlan?.scenes.find((p) => p.sceneIndex === s.index)?.needsI2V === true
    );
    const planMotionOff = scenes.map(
      (s) => approvedPlan?.scenes.find((p) => p.sceneIndex === s.index)?.motion === "off"
    );
    const humanMotionOff = scenes.map((s) => motionOverrides.get(s.index) === "off");
    const docCameraKeys = scenes.map((s) => docScenes?.[s.index - 1]?.cameraKeys != null);
    const channels = selectChannels({
      mode: opts.mode,
      motionOff: motion.mode === "off" || motion.intensity < 1,
      planNeedsI2V,
      planMotionOff,
      humanMotionOff,
      docCameraKeys,
      hasStock,
      i2vReady,
    });
    // Mutable copy for the result: an i2v scene that falls back mid-render
    // updates its decision, so RenderResult.liveliness reports what PLAYED,
    // not what was planned.
    const liveliness: LivelinessDecision[] = channels.map((d) => ({ ...d }));
    const directorSceneByIndex = new Map(
      (approvedPlan?.scenes ?? []).map((s) => [s.sceneIndex, s])
    );

    const needsPlan = channels.some((d) => d.channel === "kenburns");
    const plans =
      opts.mode === "animated"
        ? []
        : opts.mode === "slides"
          ? scenes.map((s) => slideMotionPlan(s, motion))
          : needsPlan
            ? planSceneMovements(scenes, motion, {
                aspect: motionAspect,
                ctx: opts.motionContext,
                durationsSec: durations,
              })
            : [];

    // M2 — the approved Director shot list becomes the authoritative shot
    // plan of every Ken Burns scene (docs/director-m1-m2-spec.md §1.3). ONE
    // plan read for the whole video (hoisted into the S35 block above — the
    // selector consumes the same rows); per scene: buildSceneShots (pure) →
    // ensureShotImages (≤3 extra AI images, failures demote to pseudo). ANY
    // failure here falls back to the legacy single-image path — the render
    // never breaks on the Director. No approved plan → this block is skipped
    // entirely and every scene renders bit-identical to the pre-M2 path.
    let shotPlans: (SceneShotPlan | undefined)[] | null = null;
    if (needsPlan && approvedPlan && approvedPlan.scenes.length > 0) {
      try {
        const byScene = new Map(approvedPlan.scenes.map((s) => [s.sceneIndex, s]));
        const shotPlans2: (SceneShotPlan | undefined)[] = [];
        let plannedScenes = 0;
        for (const [i, scene] of scenes.entries()) {
          // S35: the channel list IS the Ken Burns set — stock scenes with
          // footage, i2v-picked scenes and slides keep their own visual path
          // (their motion plans are ignored too).
          if (channels[i]?.channel !== "kenburns") {
            shotPlans2.push(undefined);
            continue;
          }
          const sp = buildSceneShots({
            scene,
            planScene: byScene.get(scene.index) ?? null,
            measuredSec: durations[i],
          });
          shotPlans2.push(await ensureShotImages({ videoId: opts.videoId, scene, plan: sp }));
          if (byScene.has(scene.index)) plannedScenes++;
        }
        // A plan that matches no rendered scene (scenes edited after
        // approval) has no bearing on this video — legacy path everywhere.
        if (plannedScenes > 0) shotPlans = shotPlans2;
      } catch (err) {
        renderLog.warn("director shot plan unavailable — legacy motion path", { err });
        shotPlans = null;
      }
    }

    // Stage 5 (module D) — an APPROVED director plan overrides the video-level
    // motion mode PER SCENE (the director picks the movement channel per shot
    // list; "off" deliberately stills a scene, zoom/pan narrow it). Only the
    // Ken Burns channel is overridden: slides keep their deterministic deck
    // plans, stock plays real footage, and i2v scenes move for real (S35 —
    // a Ken Burns override on a true-motion scene would contradict the pick;
    // "off" was already honored upstream by the selector).
    if (needsPlan && opts.mode !== "slides" && plans.length === scenes.length) {
      if (motionOverrides.size > 0) {
        for (let i = 0; i < scenes.length; i++) {
          const mode = motionOverrides.get(scenes[i].index);
          if (!mode) continue;
          if (shotPlans?.[i]) continue; // M2: the Director's per-shot moves are senior (spec §1.3)
          if (channels[i]?.channel !== "kenburns") continue; // S35: overrides steer the KB camera only
          plans[i] = planSceneMovements(
            [scenes[i]],
            { ...motion, mode },
            {
              aspect: motionAspect,
              ctx: opts.motionContext,
              durationsSec: [durations[i]],
            }
          )[0];
        }
      }
    }

    // S2 wave 2 — the studio's per-scene CAMERA KEYFRAMES outrank every auto
    // camera (LAST word, after the Director's motion map): the doc's two-key
    // plan replaces the motion plan AND drops the Director's shot graph for
    // that scene — an explicit user edit is senior by definition; the
    // Director keeps every scene the user didn't touch. Ken Burns scenes
    // only: footage modes play real clips, where camera keys have no
    // purchase (the inspector says so on those scenes).
    if (docScenes && needsPlan && opts.mode === "kenburns") {
      for (let i = 0; i < scenes.length; i++) {
        const cam = docScenes[i]?.cameraKeys ?? null;
        if (!cam) continue;
        plans[i] = studioCameraPlan(cam, durations[i]);
        if (shotPlans) shotPlans[i] = undefined;
      }
    }

    // Stage 5 (module E) — audio direction from an APPROVED plan: per-scene
    // ambience beds (synthesized once, looped under the narration) + the
    // director's scene-boundary cue suggestions. The plan can only ADD a
    // cue — it never removes one the story pass already chose.
    // S5 — the doc's studio picks outrank the plan's; beds materialize
    // ON DEMAND (a doc-only pick synthesizes its own bed — the old
    // plan-prebuilt map could never have heard it).
    const planAudio = await getApprovedAudioMap(opts.videoId);
    const ambienceCache = new Map<string, string | null>();
    const ambiencePathFor = async (kind: string | null): Promise<string | null> => {
      if (!kind) return null;
      if (!ambienceCache.has(kind)) {
        ambienceCache.set(kind, await ensureAmbience(kind).catch(() => null));
      }
      return ambienceCache.get(kind) ?? null;
    };

    // 1.5) Keynote slides — design the deck (LLM, cached) and screenshot it.
    // (Cancellation rides the same onProgress checkpoints as every stage —
    // the deck render itself is ~1 s per slide, no mid-pass checkpoint.)
    if (opts.mode === "slides") {
      report(scenes.length, "Designing slide deck");
      const deck = await planSlides(opts.videoId, scenes, {
        topic: opts.topic ?? null,
        niche: opts.motionContext?.niche ?? null,
        tone: opts.motionContext?.tone ?? null,
      });
      try {
        await renderSlidePngs(
          opts.videoId,
          scenes.map((scene, i) => ({ scene, spec: deck.specs[i] })),
          {
            brand: opts.brand ?? null,
            onProgress: (_done, _total, label) => {
              opts.onProgress?.(scenes.length + 1, scenes.length + 1, label);
            },
          }
        );
      } catch (err) {
        throw new Error(
          `Slide rendering failed — Playwright/Chromium is required for keynote slides (${String(err).slice(0, 160)})`
        );
      }
    }

    // 2) One segment per scene (visual + narration audio, exact duration).
    const segPaths: string[] = [];
    // S55 — the M2 shot-graph joins per scene (scene-local clock), recorded
    // by the segments that actually rendered through the multi-shot path —
    // i2v/stock/slides scenes carry none (their channels have no intra-scene
    // flips), and neither do M2 scenes that fell back before the graph ran.
    const shotJoinMarks: (ShotJoinMark[] | undefined)[] = [];
    for (const [i, scene] of scenes.entries()) {
      // S35 — the label tells the truth about WHO is playing: the channel
      // decides, and a per-scene i2v pick says so by name.
      const chan = channels[i]?.channel;
      const label =
        chan === "i2v"
          ? opts.mode === "animated"
            ? `Animating scene ${i + 1}`
            : `Animating scene ${i + 1} — director's true-motion pick`
          : chan === "stock"
            ? `Cutting stock footage — scene ${i + 1}`
            : `Composing scene ${i + 1}`;
      report(i, label);
      const segPath = path.join(tmpDir, `seg-${String(i + 1).padStart(2, "0")}.mp4`);
      const doc = docScenes?.[i] ?? null;
      // S5 — the one precedence rule: the doc's studio pick, then the plan's,
      // then the story pass's row value; null everywhere = no sound. The
      // resolver sanitizes ALL three sources (a plan row is data too).
      const sfxKind =
        resolveSoundChoice(doc?.sfxKind ?? null, planAudio.sfx.get(scene.index) ?? scene.sfx, SFX_CATALOG) ??
        "none";
      const ambienceKind = resolveSoundChoice(
        doc?.ambientKind ?? null,
        planAudio.ambience.get(scene.index) ?? null,
        AMBIENCE_CATALOG
      );
      await buildSegment({
        videoId: opts.videoId,
        scene,
        dur: durations[i],
        mode: opts.mode,
        // S35 — the selector's verdict for this scene (undefined → the
        // mode's own default; can't happen here, the list is always built).
        channel: chan,
        directorScene: directorSceneByIndex.get(scene.index) ?? null,
        onI2vFallback: (sceneIndex, reason) => {
          const d = liveliness.find((x) => x.sceneIndex === sceneIndex);
          if (d) {
            d.channel = "kenburns";
            d.reason = `i2v unavailable — Ken Burns fallback (${reason.slice(0, 90)})`;
          }
          report(i, `Composing scene ${i + 1} — i2v unavailable, Ken Burns fallback`);
        },
        onShotJoins: (marks) => {
          shotJoinMarks[i] = marks;
        },
        motion,
        plan: plans[i],
        shotPlan: shotPlans?.[i],
        sfx: opts.sfx !== false,
        sfxKind,
        ambiencePath: await ambiencePathFor(ambienceKind),
        // S2 — the doc's per-scene mix (voice/SFX/ambience) IS the mix.
        docLevels: doc
          ? {
              voice: doc.voiceLevel ?? 1,
              sfx: doc.sfxLevel ?? 0.35,
              ambient: doc.ambientLevel ?? 0.1,
            }
          : null,
        // S2 wave 2 — the creative layer rides the same aligned doc.
        docGrade: doc?.grade ?? null,
        docTitle: doc?.titleOverlay ?? null,
        docCamera: doc?.cameraKeys ?? null,
        docSpeed: doc?.speed ?? null,
        docFades: doc?.voiceFades ?? null,
        // S3 — keying + corner overlay ride the same aligned doc.
        docChroma: doc?.chroma ?? null,
        docPip: doc?.pip ?? null,
        quality: opts.quality ?? "standard",
        wavDur: wavs[i],
        outPath: segPath,
        aspect: motionAspect,
        fps: motionFps,
      });
      segPaths.push(segPath);
    }

    // 3) Stitch into the base video — the timeline doc's PER-BOUNDARY
    // transitions (S2): the incoming scene's transitionIn style wins over
    // the video-level default seam by seam; cuts become stitch points.
    // Slides keep their native hard-cut grammar UNLESS the doc carries a
    // real per-scene pick (the studio's preview has been showing the doc's
    // blends all along — the render now matches it).
    report(scenes.length, "Stitching scenes");
    const trans = sanitizeTransition(opts.transition);
    const boundary: TransitionSettings[] = [];
    for (let b = 0; b + 1 < scenes.length; b++) {
      const docStyle = docScenes?.[b + 1]?.transitionIn ?? null;
      boundary.push({
        style:
          docStyle != null && TRANSITION_IDS.has(docStyle as never)
            ? sanitizeTransitionStyle(docStyle)
            : trans.style,
        durationSec: trans.durationSec,
      });
    }
    const basePath = path.join(tmpDir, "base.mp4");
    await stitchSegments({
      segPaths,
      durationsSec: durations,
      settings: boundary,
      outPath: basePath,
      quality: QUALITY_ENCODING[opts.quality ?? "standard"],
    });

    // 4) Subtitles + music, then move into place.
    // Captions must live on the BLENDED timeline: each boundary pulls every
    // later scene d seconds earlier, so unshifted cues would drift late and
    // run past the end of the shorter video. Per-boundary debt now (S2) —
    // mixed cut/blend docs shift each seam by its own d.
    const blended =
      scenes.length < 2 || boundary.every((s) => s.style === "cut")
        ? segments
        : shiftSegmentsForBlendMulti(segments, boundary);

    // S2/S43 — the caption override chain: the doc's studio-edited caption
    // first, then a human-edited row caption (captionUser), else the smart
    // path's word-synced narration chunks. One helper feeds BOTH caption
    // paths (smart + fallback) so they can never drift.
    const docCaptions = captionOverridesFor(
      scenes,
      docScenes ? docScenes.map((d) => d.caption) : null
    );
    const capScenes = scenes.map((s, i) => {
      const edited = docCaptions[i];
      return edited ? { ...s, caption: edited } : s;
    });

    let srtPath: string | null = null;
    if (opts.burnSubtitles) {
      srtPath = path.join(tmpDir, "captions.srt");
      if (opts.smartCaptions) {
        // Audio-synced cues: ASR word alignment + speech-run detection.
        try {
          report(scenes.length, "Syncing captions to narration");
          const smart = await buildSmartSrt({
            videoId: opts.videoId,
            scenes,
            segments: blended,
            asr: true,
            captionOverrides: docCaptions,
            onProgress: (label) => opts.onProgress?.(scenes.length + 1, scenes.length + 1, label),
          });
          fs.writeFileSync(srtPath, smart.srt);
          renderLog.info(
            "smart captions written",
            { cues: smart.cueCount, method: smart.method }
          );
        } catch (err) {
          renderLog.warn("smart captions failed — falling back to scene captions", { err });
          fs.writeFileSync(srtPath, buildSrtFromSegments(capScenes, blended));
        }
      } else {
        fs.writeFileSync(srtPath, buildSrtFromSegments(capScenes, blended));
      }
    }
    // S2 — per-scene music-bed levels from the doc: a RELATIVE automation on
    // the library bed (factor = docLevel / video-slider-level, the same 0..1
    // slider curve both sides). Uniform or absent levels produce no filter —
    // the classic bed. The drone fallback keeps its fixed profile (it never
    // carried a slider), and a slider parked at 0 keeps the global mute.
    let musicAutomation: string | null = null;
    if (opts.music && opts.musicTrack && docScenes) {
      const sliderLevel = opts.musicTrack.gain / MUSIC_SLIDER_GAIN;
      if (sliderLevel > 0.001) {
        const factors = docScenes.map((d) =>
          d.musicLevel != null ? Math.min(Math.max(d.musicLevel / sliderLevel, 0), 8) : 1
        );
        musicAutomation = musicLevelAutomation(blended, factors);
      }
    }
    report(scenes.length, "Adding captions & music");
    await finalize({
      base: basePath,
      out: outPath,
      burnSubtitles: opts.burnSubtitles,
      music: opts.music,
      musicNiche: opts.musicNiche,
      musicTrack: opts.musicTrack,
      musicDuck: opts.musicDuck,
      srtPath,
      scenes,
      segments,
      // S6 — the doc's caption-style pick, mapped to ASS for this
      // orientation (slides mode forces the vertical variant of the SAME
      // pick; no pick = the classic look, byte-identical to pre-S6).
      subtitleStyle: captionAssStyle(opts.captionStyleId, opts.mode === "slides"),
      musicAutomation,
      quality: QUALITY_ENCODING[opts.quality ?? "standard"],
    });

    // Always refresh the exported caption track for the ZIP (full render only).
    if (!isPreview) {
      const exportSrt = path.join(dir, "subtitles.srt");
      if (opts.burnSubtitles && srtPath && fs.existsSync(srtPath))
        fs.copyFileSync(srtPath, exportSrt);
      else fs.writeFileSync(exportSrt, buildSrtFromSegments(capScenes, blended));
    }

    const durationSec = await probeDuration(outPath);
    const fileBytes = fs.statSync(outPath).size;

    // Storage seam (T-3.7): publish the finished artifact through the driver
    // (s3: upload from scratch; local: no-op move + quota accounting) and
    // persist the caption track the same way. Snapshot sizes first — the s3
    // branch consumes the scratch file.
    await storage.putFromPath(`${opts.videoId}/${outName}`, outPath);
    if (!isPreview) {
      const exportSrt = path.join(dir, "subtitles.srt");
      await storage.putFromPath(`${opts.videoId}/subtitles.srt`, exportSrt);
    }

    return {
      fileName: outName,
      durationSec,
      fileBytes,
      aspect: motionAspect,
      // QC black-frame exemptions — every fadeblack boundary in the doc's
      // per-scene catalog (S2: mixed styles dip exactly where told to).
      blackWindows: scenes.length > 1 ? fadeblackWindowsMulti(durations, boundary) : [],
      // S36 — the continuity expectation, built from the SAME durations +
      // per-boundary settings the stitcher just consumed: hard cuts must
      // appear in the pixels, blend windows explain detections nearby.
      // S55 — plus the M2 shot graph's own intra-scene joins (what actually
      // executed, per scene), so the graph's flips read as designed
      // boundaries instead of "unexpected" cuts (T-55.2).
      expectedCuts: expectedCutsForTimeline(durations, boundary, shotJoinMarks),
      // S35 — the liveliness ledger (what played, per scene, and why).
      liveliness,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
