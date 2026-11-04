// preview-lanes.ts — the Timeline Studio's pure projection layer.
//
// The assembled timeline (timeline.ts) is a FLAT scene document — the video
// row is the source of truth and the timeline is its editable projection.
// The Studio surface needs two views of that same document, and both are
// pure functions so they can never drift apart:
//
//   1. LANES     projectLanes(timeline) — the horizontal track view:
//                one video clip per scene (with its transitions), one voice
//                clip per scene, one caption clip per captioned scene. The
//                lanes share the scene windows exactly, so a trim in the
//                video lane is the same trim in the voice lane.
//
//   2. FRAMES    resolveFrame(t, timeline, settings) — "what does frame t
//                look like": which scene is on top, is a seam being blended
//                (and how far), and the approximate Ken Burns camera for
//                each visible layer. The preview canvas paints this; the
//                same resolver answers hit-testing for the playhead.
//
// Everything here is deterministic and DOM-free — unit-tested offline in
// scripts/test-unit.mts, consumed by the client component. The render
// pipeline (ffmpeg) stays the source of truth for the final MP4; the
// preview is a close, instant approximation of it.
//
// Camera approximation note: the render's real camera plans come from
// motion.ts (Smart Motion, director plans, pseudo crops). Reproducing that
// graph client-side would duplicate a 1,000-line engine for marginal gain;
// instead the preview mirrors the DEFAULTS the vast majority of renders use
// — a 12% push with smooth easing, direction varied per scene — and honors
// the per-video motionIntensity / motionCurve / motionVary overrides.

import type { AssembledTimeline } from "./timeline";
import { cameraAtKeys, type SceneCameraKeys } from "./studio-doc";
import { sanitizeMotion } from "./motion";
import { sanitizeTransitionDuration } from "./transitions";

// ---------- settings ----------

export interface PreviewSettings {
  aspectRatio: "16:9" | "9:16" | "1:1";
  frameRate: number; // 24 | 30 | 60
  motionIntensity: number; // % zoom amplitude (render default 12)
  motionCurve: "smooth" | "linear";
  motionVary: boolean;
  transitionDurationSec: number; // seam blend length (render default 0.5)
}

export const PREVIEW_DEFAULTS: PreviewSettings = {
  aspectRatio: "16:9",
  frameRate: 30,
  motionIntensity: 12,
  motionCurve: "smooth",
  motionVary: true,
  transitionDurationSec: 0.5,
};

/** Clamp helper for building settings from nullable VideoDTO fields. */
export function previewSettingsFrom(partial: {
  aspectRatio?: string | null;
  frameRate?: number | null;
  motionIntensity?: number | null;
  motionCurve?: string | null;
  motionVary?: boolean | null;
  transitionDurationSec?: number | null;
}): PreviewSettings {
  const ratio =
    partial.aspectRatio === "9:16" || partial.aspectRatio === "1:1" ? partial.aspectRatio : "16:9";
  const fps = partial.frameRate === 24 || partial.frameRate === 60 ? partial.frameRate : 30;
  // S15: the motion quartet + the blend length resolve through the SAME
  // law the render job uses (motion.ts / transitions.ts). The old inline
  // `Number(x) || 12` turned a LEGAL explicit 0 (the slider's "None") back
  // into 12 — the preview moved while the render held still.
  const motion = sanitizeMotion({
    intensity: partial.motionIntensity,
    curve: partial.motionCurve,
    vary: partial.motionVary,
  });
  return {
    aspectRatio: ratio,
    frameRate: fps,
    motionIntensity: motion.intensity,
    motionCurve: motion.curve,
    motionVary: motion.vary,
    transitionDurationSec: sanitizeTransitionDuration(partial.transitionDurationSec),
  };
}

// ---------- razor: where narration actually lives ----------
//
// The razor (split) cuts a scene at the playhead, but the server only accepts
// cuts INSIDE the spoken read: render.ts pads every scene window with LEAD
// silence + TAIL breathing room, and clip-ops.ts guards 0.25s on each side
// of the WAV itself. render.ts can't be imported here (it drags ffmpeg/fs
// into the client bundle), so the three numbers below mirror its exports —
// scripts/test-unit.mts cross-checks them against the real thing.
export const R_LEAD_SEC = 0.35;
export const R_TAIL_SEC = 0.85;
export const R_MIN_SEG_SEC = 2.0;
export const SPLIT_EDGE_GUARD_SEC = 0.25;

export interface SpeakableSpan {
  /** Global timeline seconds where a razor cut is legal (inclusive). */
  startSec: number;
  endSec: number;
}

/** The span a razor can cut, in GLOBAL seconds.
 *
 * `wavDurSec` — the scene WAV's real duration when known (the assemble GET
 * and clip-op responses carry per-scene WAV durations) — makes the span an
 * exact mirror of clip-ops.ts's splitNarrationAt window, even for scenes
 * whose doc duration was trimmed away from the natural segment.
 *
 * Without it the span is ESTIMATED as durationSec − lead − tail, which is
 * exact for freshly assembled docs but drifts on trims; a duration at/below
 * the MIN_SEG floor cannot be estimated at all (the real read is unknowable
 * from the doc) and returns null. The server remains the authority either
 * way — its 400 is the backstop for estimates that drift. */
export function speakableSpan(
  startSec: number,
  durationSec: number,
  wavDurSec?: number
): SpeakableSpan | null {
  // An explicitly provided wav (even 0/NaN — no read, unparseable) is the
  // TRUTH: never silently replaced by an estimate. Only an absent value
  // estimates from the doc duration.
  const hasWav = typeof wavDurSec === "number" && Number.isFinite(wavDurSec);
  const wav = hasWav
    ? (wavDurSec as number)
    : durationSec > R_MIN_SEG_SEC
      ? durationSec - R_LEAD_SEC - R_TAIL_SEC
      : 0;
  const start = startSec + R_LEAD_SEC + SPLIT_EDGE_GUARD_SEC;
  const end = startSec + R_LEAD_SEC + wav - SPLIT_EDGE_GUARD_SEC;
  return end > start ? { startSec: start, endSec: end } : null;
}

// ---------- lanes ----------

export interface VideoLaneClip {
  sceneIndex: number;
  title: string;
  startSec: number;
  durationSec: number;
  transitionIn: string | null;
  transitionOut: string | null;
  source: "ai" | "stock" | "slides";
}

export interface VoiceLaneClip {
  sceneIndex: number;
  startSec: number;
  durationSec: number;
  level: number; // 0..1
  enabled: boolean;
}

export interface CaptionLaneClip {
  sceneIndex: number;
  startSec: number;
  durationSec: number;
  text: string;
}

export interface StudioLanes {
  video: VideoLaneClip[];
  voice: VoiceLaneClip[];
  captions: CaptionLaneClip[];
  totalSec: number;
}

/** Project the flat scene document into the three studio lanes. */
export function projectLanes(t: AssembledTimeline): StudioLanes {
  const video: VideoLaneClip[] = [];
  const voice: VoiceLaneClip[] = [];
  const captions: CaptionLaneClip[] = [];
  for (const s of t.scenes) {
    const dur = Math.max(0.5, s.durationSec);
    video.push({
      sceneIndex: s.index,
      title: s.title || `Scene ${s.index}`,
      startSec: s.startSec,
      durationSec: dur,
      transitionIn: s.transitionIn,
      transitionOut: s.transitionOut,
      source: s.source,
    });
    voice.push({
      sceneIndex: s.index,
      startSec: s.startSec,
      durationSec: dur,
      level: s.audio.voice.level,
      enabled: s.audio.voice.enabled && s.audio.voice.level > 0,
    });
    if (s.caption?.text) {
      captions.push({
        sceneIndex: s.index,
        startSec: s.startSec,
        durationSec: dur,
        text: s.caption.text,
      });
    }
  }
  return { video, voice, captions, totalSec: t.totalDurationSec };
}

// ---------- camera ----------

export interface CameraTransform {
  /** Uniform scale (cover-fit base 1.0). */
  scale: number;
  /** Horizontal offset as a fraction of frame width (−0.5..0.5). */
  dx: number;
  /** Vertical offset as a fraction of frame height (−0.5..0.5). */
  dy: number;
}

const IDENTITY: CameraTransform = { scale: 1, dx: 0, dy: 0 };

// Deterministic per-scene direction cycle (mirrors motion.ts's "vary
// direction between scenes" default). A fixed cycle (not a hash) keeps the
// preview stable across saves and reloads of the same document.
type CameraMove = "push-in" | "pull-out" | "pan-right" | "pan-left";
const VARY_CYCLE: CameraMove[] = ["push-in", "pan-right", "pull-out", "pan-left"];

function cameraMoveFor(sceneIndex: number, vary: boolean): CameraMove {
  if (!vary) return "push-in";
  return VARY_CYCLE[(sceneIndex - 1 + VARY_CYCLE.length * 1024) % VARY_CYCLE.length];
}

function ease(curve: "smooth" | "linear", p: number): number {
  const c = Math.min(1, Math.max(0, p));
  if (curve === "linear") return c;
  // easeInOutSine — the render's cinematic easing.
  return (1 - Math.cos(Math.PI * c)) / 2;
}

/**
 * The approximate Ken Burns camera for scene `sceneIndex` at local time
 * `localSec` into its `durationSec` window. Pure + deterministic.
 *
 * S2 wave 2 — a doc scene carrying `cameraKeys` (the user's two-key camera)
 * overrides the auto cycle entirely: the window lerps from.key → to.key with
 * the doc's ease, in the SAME vocabulary the render's zoompan consumes
 * (window center fractions + scale). The 40% framing margin of the auto
 * moves doesn't apply — the user asked for exactly this framing; the render
 * clamps the window legally, and so does this interpolation via clamping cx/cy.
 */
export function cameraAt(
  sceneIndex: number,
  localSec: number,
  durationSec: number,
  s: PreviewSettings,
  keys?: SceneCameraKeys | null
): CameraTransform {
  if (durationSec <= 0) return IDENTITY;
  const p = Math.min(1, Math.max(0, localSec / durationSec));
  if (keys) {
    const k = cameraAtKeys(keys, p);
    return {
      scale: k.scale,
      dx: (0.5 - k.cx) * k.scale,
      dy: (0.5 - k.cy) * k.scale,
    };
  }
  const e = ease(s.motionCurve, p);
  const amp = s.motionIntensity / 100; // 0.12 default
  switch (cameraMoveFor(sceneIndex, s.motionVary)) {
    case "push-in":
      // 1.00 → 1+amp, centered.
      return { scale: 1 + amp * e, dx: 0, dy: 0 };
    case "pull-out":
      // 1+amp → 1.00, centered.
      return { scale: 1 + amp * (1 - e), dx: 0, dy: 0 };
    case "pan-right": {
      // Hold a base zoom (half amplitude — keeps pan edges covered with
      // margin), travel left→right. Travel span: half the zoom overshoot
      // so no edge is ever exposed on 16:9 or 9:9 sources.
      const base = 1 + amp / 2;
      const span = amp / 4; // fraction of frame width
      return { scale: base, dx: -span + 2 * span * e, dy: 0 };
    }
    case "pan-left": {
      const base = 1 + amp / 2;
      const span = amp / 4;
      return { scale: base, dx: span - 2 * span * e, dy: 0 };
    }
  }
}

// ---------- frames ----------

export interface FrameLayer {
  sceneIndex: number;
  /** Time within this scene's window (0..duration). */
  localSec: number;
  camera: CameraTransform;
}

export interface FrameBlend {
  fromIndex: number;
  toIndex: number;
  style: string;
  /** 0 at the window's start, 1 at its end. */
  progress: number;
}

export interface FrameLayout {
  /** Scene whose window contains t (the incoming scene during a blend). */
  activeIndex: number;
  localSec: number;
  /** Bottom→top paint order: the outgoing scene first during a blend. */
  layers: FrameLayer[];
  blend: FrameBlend | null;
  /** Caption text visible at t (null when the scene has no caption). */
  caption: string | null;
}

/** The seam blend length between scenes i and i+1 — the render's 0.2..1.5s
 *  clamp, additionally capped at 40% of the shorter scene so a blend never
 *  swallows a punchy scene whole. */
function blendDuration(prevDur: number, nextDur: number, s: PreviewSettings): number {
  const cap = Math.min(s.transitionDurationSec, Math.max(0.2, Math.min(prevDur, nextDur) * 0.4));
  return Math.max(0.2, cap);
}

/**
 * Resolve the frame at time t: which layers to paint, in what order, with
 * which cameras; the seam blend state; the caption. Returns null for an
 * empty timeline or t outside the document (t > total).
 */
export function resolveFrame(
  tSec: number,
  timeline: AssembledTimeline,
  s: PreviewSettings
): FrameLayout | null {
  const scenes = timeline.scenes;
  if (scenes.length === 0) return null;
  const total = timeline.totalDurationSec;
  let t = Number.isFinite(tSec) ? tSec : 0;
  t = Math.min(Math.max(0, t), Math.max(0, total - 0.0001));

  // Locate the scene whose window contains t.
  let idx = 0;
  for (let i = 0; i < scenes.length; i++) {
    if (t >= scenes[i].startSec && t < scenes[i].endSec) {
      idx = i;
      break;
    }
    if (t >= scenes[i].endSec) idx = i; // past the end (t == total)
  }
  const scene = scenes[idx];
  const localSec = t - scene.startSec;

  // Seam blend: the window STRADDLES the boundary — the tail of the outgoing
  // scene + the head of the incoming one. Two probes (mutually exclusive:
  // the 40% cap keeps both windows inside their own half of the scene):
  //   • BACKWARD — t is near the START of the active scene: blend from idx-1.
  //   • FORWARD  — t is near the END of the active scene: blend into idx+1.
  // The style is always the INCOMING scene's transitionIn (the render reads
  // the same field); "cut" never blends.
  const styleOf = (sc: (typeof scenes)[number]) =>
    sc.transitionIn && sc.transitionIn !== "cut" ? sc.transitionIn : null;

  let blend: FrameBlend | null = null;
  let outgoing: (typeof scenes)[number] | null = null;
  let incoming: (typeof scenes)[number] | null = null;

  if (idx > 0) {
    const prev = scenes[idx - 1];
    const style = styleOf(scene);
    if (style) {
      const d = blendDuration(prev.durationSec, scene.durationSec, s);
      if (t <= scene.startSec + d / 2) {
        const start = scene.startSec - d / 2; // = prev.endSec − d/2
        blend = {
          fromIndex: prev.index,
          toIndex: scene.index,
          style,
          progress: Math.min(1, Math.max(0, (t - start) / d)),
        };
        outgoing = prev;
        incoming = scene;
      }
    }
  }
  if (!blend && idx < scenes.length - 1) {
    const next = scenes[idx + 1];
    const style = styleOf(next);
    if (style) {
      const d = blendDuration(scene.durationSec, next.durationSec, s);
      if (t >= scene.endSec - d / 2) {
        const start = scene.endSec - d / 2;
        blend = {
          fromIndex: scene.index,
          toIndex: next.index,
          style,
          progress: Math.min(1, Math.max(0, (t - start) / d)),
        };
        outgoing = scene;
        incoming = next;
      }
    }
  }

  const layers: FrameLayer[] = [];
  if (blend && outgoing && incoming) {
    // Outgoing at its tail camera, incoming at its head camera.
    layers.push({
      sceneIndex: outgoing.index,
      localSec: outgoing.durationSec,
      camera: cameraAt(outgoing.index, outgoing.durationSec, outgoing.durationSec, s, outgoing.cameraKeys),
    });
    layers.push({
      sceneIndex: incoming.index,
      localSec: Math.max(0, t - incoming.startSec),
      camera: cameraAt(incoming.index, Math.max(0, t - incoming.startSec), incoming.durationSec, s, incoming.cameraKeys),
    });
  } else {
    layers.push({
      sceneIndex: scene.index,
      localSec: localSec,
      camera: cameraAt(scene.index, localSec, scene.durationSec, s, scene.cameraKeys),
    });
  }

  const caption = scene.caption?.text ? scene.caption.text : null;
  return { activeIndex: scene.index, localSec, layers, blend, caption };
}

// ---------- playhead helpers ----------

/** Snap t to the nearest boundary (scene seams) within maxSnap seconds. */
export function snapToBoundaries(t: number, boundaries: number[], maxSnap: number): number {
  let best = t;
  let bestDist = maxSnap;
  for (const b of boundaries) {
    const d = Math.abs(t - b);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

/** All scene seams + start/end — the snap candidates for the playhead. */
export function seamBoundaries(timeline: AssembledTimeline): number[] {
  const out: number[] = [];
  if (timeline.totalDurationSec > 0) out.push(0, timeline.totalDurationSec);
  for (const s of timeline.scenes) {
    if (s.startSec > 0) out.push(s.startSec);
    if (s.endSec > 0 && s.endSec < timeline.totalDurationSec) out.push(s.endSec);
  }
  return out;
}

/** MM:SS.FF (frames at the preview's fps) — the studio's timecode. */
export function formatTimecode(t: number, fps: number): string {
  const clamped = Math.max(0, t);
  const totalFrames = Math.round(clamped * fps);
  const ff = totalFrames % fps;
  const totalSec = Math.floor(totalFrames / fps);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(mm)}:${pad(ss)}.${pad(ff)}`;
}
