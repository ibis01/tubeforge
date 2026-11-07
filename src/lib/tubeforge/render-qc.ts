// S36 — render QC lenses: flicker, stutter, cut alignment.
//
// The S33-era battery (qc.ts) already measures exact freezes (freezedetect),
// long static stretches (sampled visual-change scan) and pacing (the
// approved plan's own rhythm). Three defect classes still slipped through
// every lens the owner audit named:
//
//   1. FLICKER   — luminance pumping: brightness oscillates fast enough to
//                  read as a strobe/glitch while no single frame is frozen
//                  and no run is static. i2v clips and broken blends pump.
//   2. STUTTER   — uneven frame timing: duplicated presentation frames
//                  (identical pts) and timestamp gaps. The eye reads both
//                  as judder, especially mid-pan.
//   3. CUT ALIGNMENT — continuity: scene changes landing where the timeline
//                  says nothing should cut (a broken stitch), or the
//                  timeline's hard cuts missing from the pixels (a swallowed
//                  seam). The assembled timeline KNOWS where every boundary
//                  sits — this lens holds the render to it.
//
// Shape follows the battery's doctrine: a pure, synthetic-tested core
// (calibrated thresholds, explainable verdicts) behind a thin ffmpeg shell;
// a crashed probe reports "measured: false" so qc.ts can answer
// "unmeasured" — a check that never ran must never read as clean.

import { execFile } from "child_process";
import { promisify } from "util";
import {
  transitionOffsetsMulti,
  sanitizeTransitionDuration,
  type TransitionSettings,
} from "./transitions";
import type { ShotJoinMark } from "./motion";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Flicker — luminance pumping from a sampled luma track
// ---------------------------------------------------------------------------

export const FLICKER_SAMPLE = {
  /** Luma samples per second (fps filter ahead of signalstats). */
  fps: 8,
  /** |ΔY| (0..255 mean-luma units) above which a sample-to-sample jump is
   * "strong". 12 ≈ 5% brightness — visible pumping, invisible ramping. */
  magMin: 12,
  /** Alternating strong jumps needed for an event. At 8 Hz, 4 alternations
   * ≈ 0.5 s of pumping. A single +/− pair is a flash or a hard cut's
   * exposure pop — real flicker pumps repeatedly. */
  altMin: 4,
  /** Weak samples tolerated inside a run (smooth motion between pumps). */
  maxGapSamples: 2,
} as const;

export interface FlickerEvent {
  startSec: number;
  alternations: number;
}

/**
 * Collapse a sampled mean-luma track into flicker events. Pure —
 * regression-tested with synthetic series. One CONTIGUOUS pumping episode
 * is one event: a run of strong deltas accumulates alternations (same-sign
 * strong jumps keep the run alive but don't count — a crossfade is one long
 * monotone ramp, not pumping) and the event is recorded when the run ENDS
 * — a gap wider than the budget, or the end of the track. Recording at
 * run-end (not at the altMin threshold) keeps a 20-second pump from
 * fragmenting into an event per detector window.
 */
export function flickerEventsFromLuma(
  luma: number[],
  opts: typeof FLICKER_SAMPLE = FLICKER_SAMPLE
): FlickerEvent[] {
  if (luma.length < opts.altMin + 2) return [];
  const events: FlickerEvent[] = [];
  // run state: delta-index where the run began, the last strong sign, that
  // sign's delta-index, and the count of alternating strong deltas (the
  // first strong delta seeds the count at 1 — a +,−,+,− run of 4 deltas
  // spans 3 flips but is exactly the pumping altMin wants to catch).
  let runStart = -1;
  let lastSign = 0;
  let lastIdx = -1;
  let alternations = 0;
  const closeRun = (): void => {
    if (runStart >= 0 && alternations >= opts.altMin) {
      events.push({ startSec: runStart / opts.fps, alternations });
    }
    runStart = -1;
    lastSign = 0;
    lastIdx = -1;
    alternations = 0;
  };
  for (let i = 0; i < luma.length - 1; i++) {
    const d = luma[i + 1] - luma[i];
    const sign = d >= opts.magMin ? 1 : d <= -opts.magMin ? -1 : 0;
    if (sign === 0) {
      // weak sample: tolerated inside a run (gap budget), counts nothing
      if (runStart >= 0 && i - lastIdx > opts.maxGapSamples + 1) closeRun();
      continue;
    }
    if (runStart >= 0 && i - lastIdx > opts.maxGapSamples + 1) closeRun();
    if (runStart < 0) {
      runStart = i;
      alternations = 1;
      lastSign = sign;
    } else if (sign !== lastSign) {
      alternations += 1;
      lastSign = sign;
    }
    // same-sign strong deltas keep the run alive (plateau tolerance) but
    // count nothing: a crossfade is one long monotone ramp, not pumping
    lastIdx = i;
  }
  closeRun();
  return events;
}

/** Parse `signalstats,metadata=print` stderr — YAVG lines only, in order. */
export function parseYavgLog(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)/g)) {
    out.push(Number(m[1]));
  }
  return out;
}

/** Flicker probe: resample to 8 Hz / 64×36 and print per-sample mean luma.
 * Never throws — a failed probe reports measured: false. */
export async function detectFlicker(
  file: string
): Promise<{ events: FlickerEvent[]; measured: boolean }> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner", "-nostats",
        "-i", file,
        "-vf", `fps=${FLICKER_SAMPLE.fps},scale=64:36,signalstats,metadata=print`,
        "-an",
        "-f", "null", "-",
      ],
      { timeout: 8 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }
    );
    return { events: flickerEventsFromLuma(parseYavgLog(stderr.toString())), measured: true };
  } catch {
    return { events: [], measured: false };
  }
}

// ---------------------------------------------------------------------------
// Stutter — frame-timing regularity from packet timestamps
// ---------------------------------------------------------------------------

export const STUTTER_LIMITS = {
  /** Consecutive duplicated presentation frames (equal pts) that flag a run.
   * 8 frames ≈ 0.27 s @30 fps — encoder dupes come in bursts; the CFR render
   * never duplicates. */
  dupRunMin: 8,
  /** pts delta > gapFactor / fps reads as a timestamp gap. */
  gapFactor: 2.5,
  /** Gap events before the check fails (CFR renders should ship ZERO). */
  gapCountMin: 12,
} as const;

export interface StutterReport {
  /** Flagged duplicate runs — only those at/over dupRunMin. */
  dupRuns: { startSec: number; frames: number }[];
  /** Timestamp-gap moments (last good pts before the jump). */
  gaps: number[];
}

/**
 * Collapse packet pts times into duplicate runs and gaps. Pure —
 * regression-tested with synthetic and captured streams. Input is sorted
 * ascending first: packets arrive in DECODE order and H.264 B-frames make
 * pts wiggle non-monotonically; presentation order is what stutters.
 */
export function stutterFromPts(
  pts: number[],
  fps: number,
  opts: typeof STUTTER_LIMITS = STUTTER_LIMITS
): StutterReport {
  if (!Number.isFinite(fps) || fps <= 0 || pts.length < 2) return { dupRuns: [], gaps: [] };
  const sorted = [...pts].sort((a, b) => a - b);
  const dupRuns: { startSec: number; frames: number }[] = [];
  const gaps: number[] = [];
  let runFrames = 1;
  let runStart = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d < 0.002) {
      if (runFrames === 1) runStart = sorted[i - 1];
      runFrames += 1;
    } else {
      if (runFrames >= opts.dupRunMin) {
        dupRuns.push({ startSec: runStart, frames: runFrames });
      }
      runFrames = 1;
      if (d > opts.gapFactor / fps) gaps.push(sorted[i - 1]);
    }
  }
  if (runFrames >= opts.dupRunMin) {
    dupRuns.push({ startSec: runStart, frames: runFrames });
  }
  return { dupRuns, gaps };
}

/** Parse ffprobe packet CSV — one pts_time per line; N/A, negatives and
 * blank lines (the trailing newline parses as 0!) drop out. */
export function parsePtsCsv(stdout: string): number[] {
  const out: number[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const v = Number(t);
    if (Number.isFinite(v) && v >= 0) out.push(v);
  }
  return out;
}

/** Stutter probe: packet timestamps only — no decode, cheap on long renders.
 * Never throws — a failed probe reports measured: false. */
export async function detectStutter(
  file: string,
  fps: number
): Promise<StutterReport & { measured: boolean }> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "packet=pts_time",
        "-of", "csv=p=0",
        file,
      ],
      { timeout: 5 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }
    );
    return { ...stutterFromPts(parsePtsCsv(stdout.toString()), fps), measured: true };
  } catch {
    return { dupRuns: [], gaps: [], measured: false };
  }
}

// ---------------------------------------------------------------------------
// Cut alignment — detected scene changes vs the assembled timeline
// ---------------------------------------------------------------------------

/** What the timeline says the cuts should look like on the blended clock.
 * `cuts` are hard-cut boundary times (a cut MUST appear); `windows` are
 * spans [lo, hi] where any detection is explained — scene-seam blends AND
 * (S55) the M2 shot graph's own intra-scene flips. Renders without shot
 * joins ship the scene-seam contract only; single-scene renders without
 * joins ship both empty — any detected cut is then a genuine continuity
 * break. */
export interface ExpectedCuts {
  cuts: number[];
  windows: [number, number][];
}

/** Cut-match tolerance: scene detect fires on the first frame of the new
 * scene; the blended clock quantizes to frame boundaries. */
export const CUT_TOL_SEC = 0.6;

/**
 * Build the expectation from per-scene durations + per-boundary transition
 * settings — the SAME inputs stitchSegments consumes (transitionOffsetsMulti
 * is the render's own blended-clock math, so the expectation can never
 * disagree with what the render was told to do). Pure.
 *
 * S55 (T-55.3a) — `shotJoins` carries the M2 shot graph's own intra-scene
 * boundaries (renderVideo records what actually executed, per scene, on
 * each scene's LOCAL clock). They ride the expectation as WINDOWS — both
 * the hard-concat flips and the SHOT_FADE_SEC hand-offs: a flip is a
 * boundary the render owns, so a detection there is explained, but unlike
 * a scene seam it carries NO must-appear obligation — the T-55.2 evidence
 * measured a flip scoring under the lens's 0.40 scene threshold (13.25 s
 * on the anchor), which a `cuts` booking would misread as "missing".
 * Scene seams keep the must-appear side; stray cuts anywhere else still
 * flag.
 */
export function expectedCutsForTimeline(
  durationsSec: number[],
  settings: TransitionSettings[],
  shotJoins?: (ShotJoinMark[] | null | undefined)[]
): ExpectedCuts {
  const cuts: number[] = [];
  const windows: [number, number][] = [];
  const offsets = transitionOffsetsMulti(durationsSec, settings);
  offsets.forEach((off, b) => {
    const s = settings[b];
    if (s && s.style === "cut") {
      cuts.push(off);
    } else {
      windows.push([Math.max(off - 0.3, 0), off + sanitizeTransitionDuration(s?.durationSec) + 0.3]);
    }
  });
  if (shotJoins) {
    shotJoins.forEach((marks, i) => {
      if (!marks || marks.length === 0) return;
      // Scene i's local 0 sits at offsets[i-1] on the blended clock (0 for
      // the first scene) — the same math the stitcher's xfade offsets use,
      // so a join can never be booked away from where it rendered.
      const start = i === 0 ? 0 : (offsets[i - 1] ?? 0);
      for (const m of marks) {
        windows.push([Math.max(start + m.at - 0.3, 0), start + m.at + m.fadeSec + 0.3]);
      }
    });
  }
  return { cuts, windows };
}

/** Parse `select='gt(scene,…)',showinfo` stderr — every showinfo line that
 * survived the select IS one detected scene change. */
export function parseSceneCuts(stderr: string): number[] {
  const out: number[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.includes("showinfo")) continue;
    const m = line.match(/pts_time:(\d+(?:\.\d+)?)/);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/**
 * Align detected cut times against the timeline's expectation. Pure.
 * unexpected — detections away from every expected cut and blend window;
 * missing — hard cuts the pixels never show.
 */
export function alignCuts(
  detected: number[],
  expected: ExpectedCuts,
  tolSec: number = CUT_TOL_SEC
): { unexpected: number[]; missing: number[] } {
  const inWindow = (t: number): boolean =>
    expected.windows.some(([lo, hi]) => t >= lo - tolSec && t <= hi + tolSec);
  const nearCut = (t: number): boolean =>
    expected.cuts.some((c) => Math.abs(t - c) <= tolSec);
  const unexpected = detected.filter((t) => !nearCut(t) && !inWindow(t));
  const missing = expected.cuts.filter(
    (c) => !detected.some((t) => Math.abs(t - c) <= tolSec)
  );
  return { unexpected, missing };
}

/** Scene-change probe: full decode (unavoidable — the scene metric needs
 * pixels). Never throws — a failed probe reports measured: false. */
export async function detectSceneCuts(
  file: string
): Promise<{ cuts: number[]; measured: boolean }> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner", "-nostats",
        "-i", file,
        "-vf", "select=gt(scene\\,0.40),showinfo",
        "-an",
        "-f", "null", "-",
      ],
      { timeout: 8 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }
    );
    return { cuts: parseSceneCuts(stderr.toString()), measured: true };
  } catch {
    return { cuts: [], measured: false };
  }
}
