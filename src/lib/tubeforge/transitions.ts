// Scene transitions — the compositor's crossfade engine.
//
// TubeForge used to hard-cut between scene segments (concat demuxer, stream
// copy). This module adds real transitions: a curated ffmpeg xfade catalog
// for the video track with matching acrossfade blends on the audio track, so
// scenes melt into each other instead of snapping.
//
// Pure module — no fs, no ffmpeg, no Prisma. The filter-graph builder is
// unit-tested offline (scripts/test-unit.ts) and verified against the real
// ffmpeg binary by the render pipeline. render.ts only orchestrates.

// ---------- catalog ----------

export type TransitionStyle =
  | "cut" // hard cut (stream-copy concat, the classic behavior)
  | "fade" // crossfade
  | "fadeblack" // dip to black — dramatic act breaks
  | "fadewhite" // dip to white — dream / flash beats
  | "dissolve"
  | "hblur" // blur dissolve — soft cinematic hand-off
  | "wipeleft"
  | "wiperight"
  | "slideleft"
  | "slideright"
  | "smoothup"
  | "smoothdown"
  | "circleopen"
  | "radial"
  | "pixelize"; // stylized mosaic — playful niches

export interface TransitionDef {
  id: TransitionStyle;
  label: string;
  desc: string;
}

export const TRANSITIONS: TransitionDef[] = [
  { id: "cut", label: "Hard Cut", desc: "Instant switch — no blend" },
  { id: "fade", label: "Crossfade", desc: "Scenes melt together" },
  { id: "fadeblack", label: "Dip to Black", desc: "Brief black beat between scenes" },
  { id: "fadewhite", label: "Dip to White", desc: "Flash of white — dreamy pivots" },
  { id: "dissolve", label: "Dissolve", desc: "Grainy dissolve blend" },
  { id: "hblur", label: "Blur Melt", desc: "Defocus out, focus into next" },
  { id: "wipeleft", label: "Wipe ←", desc: "New scene wipes in from the left" },
  { id: "wiperight", label: "Wipe →", desc: "New scene wipes in from the right" },
  { id: "slideleft", label: "Slide ←", desc: "Next scene slides in from the right" },
  { id: "slideright", label: "Slide →", desc: "Next scene slides in from the left" },
  { id: "smoothup", label: "Smooth Up", desc: "Soft vertical wipe upward" },
  { id: "smoothdown", label: "Smooth Down", desc: "Soft vertical wipe downward" },
  { id: "circleopen", label: "Circle Open", desc: "Next scene opens in a growing circle" },
  { id: "radial", label: "Radial Sweep", desc: "Clockwise radial reveal" },
  { id: "pixelize", label: "Pixel Melt", desc: "Mosaic dissolve — stylized niches" },
];

const TRANSITION_IDS = new Set(TRANSITIONS.map((t) => t.id));

// ---------- defaults & sanitizing ----------

export const TRANSITION_DEFAULT = {
  style: "fade" as TransitionStyle,
  durationSec: 0.5,
};

export const TRANSITION_DURATION_MIN = 0.2;
export const TRANSITION_DURATION_MAX = 1.5;

/** Validate a stored/client style id; anything unknown falls back to the default. */
export function sanitizeTransitionStyle(v: unknown): TransitionStyle {
  return typeof v === "string" && TRANSITION_IDS.has(v as TransitionStyle)
    ? (v as TransitionStyle)
    : TRANSITION_DEFAULT.style;
}

/** Clamp a stored/client duration into the legal window; NaN → default. */
export function sanitizeTransitionDuration(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return TRANSITION_DEFAULT.durationSec;
  return Math.min(TRANSITION_DURATION_MAX, Math.max(TRANSITION_DURATION_MIN, n));
}

export interface TransitionSettings {
  style: TransitionStyle;
  durationSec: number;
}

/** Sanitize both fields in one call (route + render entry point). */
export function sanitizeTransition(
  v: { style?: unknown; durationSec?: unknown } | null | undefined
): TransitionSettings {
  return {
    style: sanitizeTransitionStyle(v?.style),
    durationSec: sanitizeTransitionDuration(v?.durationSec),
  };
}

// ---------- timing math (pure) ----------

/**
 * xfade offsets for the chained graph, one per boundary.
 *
 * ffmpeg's xfade `offset` is measured on the timeline of its FIRST input —
 * which, in a chain, is the already-blended accumulator, not the original
 * segment. Each blend shortens the timeline by `d`, so the offset for
 * boundary b (0-based) is:  (Σ durations[0..b]) − (b + 1) · d.
 * Audio uses acrossfade, which overlaps the same D-second tails/heads and
 * therefore lands every blend at exactly the same timeline point — A/V stay
 * in sync without any extra bookkeeping.
 */
export function transitionOffsets(durationsSec: number[], durationSec: number): number[] {
  const d = sanitizeTransitionDuration(durationSec);
  const offsets: number[] = [];
  let acc = 0;
  for (let b = 0; b < durationsSec.length - 1; b++) {
    acc += Math.max(durationsSec[b], 0);
    offsets.push(Math.max(acc - (b + 1) * d, 0));
  }
  return offsets;
}

/** Final duration after all blends; null when there is nothing to blend. */
export function transitionTotalDuration(
  durationsSec: number[],
  durationSec: number
): number | null {
  if (durationsSec.length < 2) return null;
  const sum = durationsSec.reduce((a, b) => a + Math.max(b, 0), 0);
  return Math.max(sum - (durationsSec.length - 1) * sanitizeTransitionDuration(durationSec), 0);
}

/**
 * Expected black-dip windows on the BLENDED timeline when the style dips
 * through black (fadeblack). The QC gate exempts black frames inside these
 * windows — a "Dip to Black" transition is a designed beat, not a defect.
 * Window: [offset − 0.15, offset + d + 0.15] — generous to cover encoder
 * timing jitter around the plateau.
 */
export function fadeblackWindows(
  durationsSec: number[],
  durationSec: number
): [number, number][] {
  if (durationsSec.length < 2) return [];
  const d = sanitizeTransitionDuration(durationSec);
  return transitionOffsets(durationsSec, d).map((off) => [
    Math.max(off - 0.15, 0),
    off + d + 0.15,
  ]);
}

// ---------- filter graph (pure string builder) ----------

export interface TransitionGraph {
  /** Video chain: [0:v]..xfade..[v] — feed segments as inputs 0..N-1. */
  video: string;
  /** Audio chain: [0:a]..acrossfade..[a]. */
  audio: string;
  /** Output duration (Σ − (N−1)·d) for progress reporting / QC context. */
  totalDurationSec: number;
}

/**
 * Build the chained xfade + acrossfade filter graph over N segment inputs.
 * Returns null when a transition cannot apply (< 2 segments) — callers fall
 * back to the stream-copy concat. Audio crossfades with triangular fades
 * (acrossfade default curves) which sit entirely inside each segment's
 * 0.85 s tail + 0.35 s lead silence at the default 0.5 s blend, so narration
 * never gets clipped mid-word.
 */
export function buildTransitionGraph(
  durationsSec: number[],
  style: TransitionStyle,
  durationSec: number
): TransitionGraph | null {
  if (durationsSec.length < 2 || style === "cut") return null;
  const d = sanitizeTransitionDuration(durationSec);
  const offsets = transitionOffsets(durationsSec, d);

  const video: string[] = [];
  const audio: string[] = [];
  let vLabel = "0:v";
  let aLabel = "0:a";

  for (let b = 0; b < offsets.length; b++) {
    const vOut = b === offsets.length - 1 ? "v" : `bx${b}`;
    const aOut = b === offsets.length - 1 ? "a" : `ba${b}`;
    video.push(
      `[${vLabel}][${b + 1}:v]xfade=transition=${style}:duration=${d.toFixed(3)}:offset=${offsets[b].toFixed(3)},format=yuv420p[${vOut}]`
    );
    audio.push(`[${aLabel}][${b + 1}:a]acrossfade=d=${d.toFixed(3)}[${aOut}]`);
    vLabel = vOut;
    aLabel = aOut;
  }

  return {
    video: video.join(";"),
    audio: audio.join(";"),
    totalDurationSec: transitionTotalDuration(durationsSec, d) ?? 0,
  };
}

/** Human one-liner for activity logs — "Crossfade · 0.5s between scenes". */
export function transitionSummary(style: TransitionStyle, durationSec: number): string {
  if (style === "cut") return "hard cuts";
  const def = TRANSITIONS.find((t) => t.id === style);
  return `${def?.label ?? style} · ${durationSec.toFixed(1)}s between scenes`;
}

// ---------- blended-timeline consumers (captions, Shorts) ----------

// ---------- memory-bounded blending plan ----------
//
// A single chained-xfade graph over N inputs makes ffmpeg buffer frames for
// every not-yet-consumed input; RSS grows roughly linearly with input count
// (measured live: 12×1080p inputs → 2.4–3.1 GB → OOM-killed in a 4 GB
// container). The fix: blend in bounded groups, then blend the group outputs,
// recursing until one master remains. Any frame is re-encoded at most
// ceil(log_G(N)) − 1 extra times; with G=4 a 12-scene video needs just
// 3 group passes + 1 join pass and every frame sees exactly 2 generations.

/** Max inputs per chained-xfade pass (empirical: ≤4 keeps peak RSS ~1 GB). */
export const BLEND_GROUP_MAX = 4;

export interface BlendGroup {
  /** Indices into the original segment list (inclusive range start/end). */
  from: number;
  to: number; // inclusive
  /** Duration of this group's OUTPUT (Σ − (k−1)·d) — the next round's input. */
  outDurationSec: number;
}

/**
 * One round of the grouping: partition `durations` into consecutive groups of
 * at most `groupMax` inputs, sized as evenly as ceil-division allows
 * (remainder spread from the front — 13 @ G=4 → [4,4,4,1] never happens;
 * it becomes 4 groups of 3–4). Groups of one pass through untouched in the
 * next round (they carry no blend debt of their own).
 *
 * `groupMax` defaults to BLEND_GROUP_MAX (measured ~1 GB peak RSS on the
 * reference VM). Memory-constrained hosts (small VPS, dev sandboxes) pass a
 * smaller cap — every extra chained input makes ffmpeg buffer another
 * decoder queue, and an OOM-killed pass is what produces truncated
 * intermediates that fail downstream with "moov atom not found".
 */
export function planBlendGroups(
  durationsSec: number[],
  durationSec: number,
  groupMax: number = BLEND_GROUP_MAX
): BlendGroup[] {
  const cap = Math.max(2, Math.min(BLEND_GROUP_MAX, Math.floor(groupMax) || BLEND_GROUP_MAX));
  const n = durationsSec.length;
  if (n === 0) return [];
  const d = sanitizeTransitionDuration(durationSec);
  const groupCount = Math.ceil(n / cap);
  // Balance sizes: base + 1 for the first (n % groupCount) groups.
  const base = Math.floor(n / groupCount);
  const extra = n % groupCount;
  const groups: BlendGroup[] = [];
  let idx = 0;
  for (let g = 0; g < groupCount; g++) {
    const size = base + (g < extra ? 1 : 0);
    let sum = 0;
    for (let i = idx; i < idx + size; i++) sum += Math.max(durationsSec[i], 0);
    groups.push({
      from: idx,
      to: idx + size - 1,
      outDurationSec: Math.max(sum - (size - 1) * d, 0),
    });
    idx += size;
  }
  return groups;
}

/**
 * Rebase segment-timeline consumers onto the BLENDED timeline. Every boundary
 * removes d seconds before the next scene's content starts, so scene i's
 * content sits at start_i − i·d on the final video (exact for everything
 * inside the scene; the boundary windows themselves are shared by both
 * neighbours). With trimEnd, non-final scenes also lose d seconds at their
 * tail — the blend INTO the next scene — so cut windows (Shorts) stay inside
 * clean content instead of ending mid-dissolve.
 */
export function shiftSegmentsForBlend<
  T extends { start: number; duration: number }
>(segments: T[], durationSec: number, trimEnd = false): T[] {
  const d = sanitizeTransitionDuration(durationSec);
  return segments.map((seg, i) => ({
    ...seg,
    start: Math.max(seg.start - i * d, 0),
    duration:
      trimEnd && i < segments.length - 1
        ? Math.max(seg.duration - d, 0.5)
        : seg.duration,
  }));
}
