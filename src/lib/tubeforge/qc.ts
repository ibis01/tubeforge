// Post-render quality gate — the "verify the video actually plays" stage.
//
// After every FULL render (final.mp4 only, previews are exempt) the job runs
// this battery and records a JSON report on the video row:
//   1. playability   — has an H.264 video stream + AAC audio stream
//   2. duration      — video duration vs the narration length (sync sanity)
//   3. loudness      — integrated LUFS near the -16 delivery target (audiomix)
//   4. true peak     — ≤ -1 dBTP (0.2 dB AAC-overshoot tolerance)
//   5. loudness range— LRA within consistency bounds (no pumping levels)
//   6. black frames  — zero black intervals ≥ 0.25 s
//   7. dead air      — no fully-silent run ≥ 1.5 s (voice OR bed always up)
//   8. frozen frames — freezedetect (exact freezes) AND a sampled static-shot
//                      pass (visually-unchanged runs — the pacing review's
//                      "opening scene unchanged for 15 s" class of defect)
//   9. captions      — SRT cues monotonic, non-overlapping, inside duration
//  10. tail fade     — ends on a fade, not an abrupt cut
//  11. flicker       — luminance pumping (S36): brightness oscillating fast
//                      enough to strobe while no frame is frozen
//  12. stutter       — uneven frame timing (S36): duplicated presentation
//                      frames and timestamp gaps the eye reads as judder
//  13. cut alignment — continuity (S36): scene changes landing where the
//                      timeline says nothing should cut, hard cuts missing
//                      from the pixels
//
// The render never fails because of QC — the report drives the QC badge in
// the UI so a human can inspect before export/upload.
//
// Every check carries a THREE-STATE status:
//   "pass"       — measured and within bounds
//   "fail"       — measured and out of bounds
//   "unmeasured" — the analysis could not run (ffmpeg crashed, timed out,
//                  file unreadable, clip too short to sample)
// A check that never ran must never read as clean: "unmeasured" fails the
// overall report so the badge keeps asking a human to look. (Before this
// distinction, a crashed analysis pass silently reported a spotless file.)

import { execFile } from "child_process";
import fs from "fs";
import { promisify } from "util";
import {
  measureLoudness,
  detectStaticRuns,
  staticRunsDetail,
  LUFS_PASS_WINDOW,
  LRA_WARN,
  MIX_TARGETS,
} from "./audiomix";
import { planStaticRuns } from "./director-plan";
import type { DirectorPlan } from "./director-plan";
import {
  detectFlicker,
  detectStutter,
  detectSceneCuts,
  alignCuts,
  STUTTER_LIMITS,
  CUT_TOL_SEC,
} from "./render-qc";
import type { ExpectedCuts } from "./render-qc";

const execFileAsync = promisify(execFile);

export type QcStatus = "pass" | "fail" | "unmeasured";

export interface QcCheck {
  id: string;
  label: string;
  /** Authoritative result: measured-and-ok / measured-and-bad / could-not-run. */
  status: QcStatus;
  /** Legacy convenience — true only when status === "pass". Older reports
   * stored just this flag, and unmeasured checks slipped through as `true`. */
  pass: boolean;
  value: string;
  detail?: string;
}

/** Build a check with the derived legacy flag (one source of truth). */
function check(
  id: string,
  label: string,
  status: QcStatus,
  value: string,
  detail?: string
): QcCheck {
  return {
    id,
    label,
    status,
    pass: status === "pass",
    value,
    ...(detail !== undefined ? { detail } : {}),
  };
}

// S116 — the scene-scoped battery (scene-qc.ts) reuses these builders
// instead of forking private copies (the S113 no-private-copies law, now
// extended to the QC probe shell: one analyzePass, one ffprobe, one check
// builder — scene scope re-slices the SAME probes, never re-implements them).
export { check as qcCheck, analyzePass, ffprobeJson };

export interface QcReport {
  passed: boolean;
  checkedAt: string;
  durationSec: number;
  checks: QcCheck[];
  /** S45 — evidence scope. Absent/undefined = the FULL render (final.mp4,
   * every historical report). "preview" = a first-N-scenes preview render:
   * honest partial evidence for the badge, NEVER certifying the final
   * artifact (qc-policy treats a preview-scoped standing report as not
   * standing for the ship gate). */
  scope?: "preview";
}

async function ffprobeJson(file: string) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,width,height",
      "-show_entries", "format=duration",
      "-of", "json",
      file,
    ],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
  );
  return JSON.parse(stdout.toString()) as {
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
    format?: { duration?: string };
  };
}

/** One combined ffmpeg analysis pass: black frames + frozen frames + volume + silence.
 * `ok: false` means ffmpeg exited non-zero — whatever stderr came back is
 * PARTIAL, so the detectors below must report "unmeasured", never "clean". */
async function analyzePass(file: string): Promise<{ stderr: string; ok: boolean }> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner", "-nostats",
        "-i", file,
        // frozen runs must last a full second. Calibration history: d=0.30
        // flagged 0.3s sub-noise dips in slow zoom starts; d=0.50 still caught
        // the ~0.5-0.7s plateau of the smooth ease curve (cos easing has
        // near-zero slope at each shot's start/end — by-design documentary
        // motion, perceptually fine). The classes this check exists for —
        // hold-last-frame artifacts (2.3s, Battle Yamuk) and dead pans
        // (2.5s, the panEndpoints edge-pin bug) — are seconds long; d=1.0
        // catches them with margin and ignores ease plateaus.
        "-vf", "blackdetect=d=0.25:pix_th=0.10,freezedetect=n=0.004:d=1.00",
        "-af", "volumedetect,silencedetect=n=-40dB:d=1.5",
        "-f", "null", "-",
      ],
      { timeout: 8 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }
    );
    return { stderr: stderr.toString(), ok: true };
  } catch (err) {
    const e = err as { stderr?: string };
    return { stderr: e.stderr ?? "", ok: false };
  }
}

// ---------------------------------------------------------------------------
// S123 (G1) P3 — the graphics lane's designed-freeze judging (PURE). A
// motion-graphics scene LEGALLY holds its placed state after the last
// motion window ends — the kinetic-typography hold is the format's
// grammar, not a defect. The graphics job passes the doc's hold windows
// (graphics/qc.ts graphicsHoldWindows); the battery then judges a freeze
// or a sampled static run against them: STARTING inside a window is the
// design; starting elsewhere is a dead compositor. Absent windows = every
// other lane's byte-identical behavior.
// ---------------------------------------------------------------------------

/** Pure: split freezedetect starts into designed (inside a hold window) and
 *  unexpected (elsewhere — the defect). */
export function judgeFreezes(
  freezeStarts: number[],
  designed: [number, number][]
): { unexpected: number[]; designedCount: number } {
  const isDesigned = (t: number): boolean =>
    designed.some(([lo, hi]) => t >= lo - 0.1 && t <= hi + 0.1);
  const unexpected = freezeStarts.filter((t) => !isDesigned(t));
  return { unexpected, designedCount: freezeStarts.length - unexpected.length };
}

/** Pure: drop static runs that overlap a designed hold window (maximal
 *  static periods begin AT the hold — motion ends where the window starts). */
export function judgeStaticRuns(
  runs: { startSec: number; endSec: number }[],
  designed: [number, number][]
): { unexpected: { startSec: number; endSec: number }[]; designedCount: number } {
  const overlaps = (r: { startSec: number; endSec: number }): boolean =>
    designed.some(([lo, hi]) => r.startSec <= hi + 0.1 && r.endSec >= lo - 0.1);
  const unexpected = runs.filter((r) => !overlaps(r));
  return { unexpected, designedCount: runs.length - unexpected.length };
}

/** The graphics lane's frozen-frames threshold — a freeze covering this
 *  share of the PROGRAM is a dead compositor, never a designed beat. */
export const GRAPHICS_FREEZE_COVERAGE = 0.9;

/** Pure (the graphics lane): the freezedetect noise floor cannot see small
 *  kinetic motion — a counting counter or a slow fade moves fewer than 0.4%
 *  of the frame's pixels per frame, so the lens reads the FORMAT's grammar
 *  as frozen. The graphics lane's honest frozen-frames semantics are
 *  therefore DEAD-COMPOSITOR coverage: a freeze spanning ≥ 90% of the
 *  program means the applier never ran. The in-scene motion truth rides
 *  the sampled static-shots lens (its threshold sees the small motion).
 *  The P5 proof recorded the empirical pair on the proof doc: freezedetect
 *  flagged two sub-noise events while the frame extraction showed every
 *  sampled frame differing and static-shots passing. */
export function judgeGraphicsFreezes(
  freezeEvents: { startSec: number; endSec: number }[],
  programSec: number,
  coverageThreshold: number = GRAPHICS_FREEZE_COVERAGE
): { unexpected: number[]; designedCount: number } {
  const unexpected = freezeEvents
    .filter((e) => programSec > 0 && (e.endSec - e.startSec) / programSec >= coverageThreshold)
    .map((e) => e.startSec);
  return { unexpected, designedCount: freezeEvents.length - unexpected.length };
}

/** Mean volume (dBFS) of the file's final 0.4 s — abrupt-ending detector. */
async function tailVolume(file: string, durationSec: number): Promise<number | null> {
  if (!Number.isFinite(durationSec) || durationSec < 3) return null;
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner", "-nostats",
        "-ss", Math.max(0, durationSec - 0.4).toFixed(3),
        "-i", file,
        "-af", "volumedetect",
        "-f", "null", "-",
      ],
      { timeout: 3 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }
    );
    const m = stderr.toString().match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** EBU R128 loudness of the mixed track (legacy helper kept for callers that
 * only need the integrated value — the full measurement comes from
 * audiomix.measureLoudness). */
export async function loudnessPass(file: string): Promise<number | null> {
  const m = await measureLoudness(file);
  return m ? m.integratedLUFS : null;
}

interface SrtCue { start: number; end: number }

export function parseSrt(text: string): SrtCue[] {
  const toSec = (ts: string): number => {
    const m = ts.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return -1;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  };
  const cues: SrtCue[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter(Boolean);
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const [a, b] = tl.split("-->");
    const start = toSec(a);
    const end = toSec(b);
    if (start >= 0 && end > start) cues.push({ start, end });
  }
  return cues;
}

/** Frame geometry expectations — vertical and square are first-class formats. */
export type QcAspect = "16:9" | "9:16" | "1:1";

const ASPECT_TARGET: Record<QcAspect, { w: number; h: number; label: string }> = {
  "16:9": { w: 1920, h: 1080, label: "16:9 frame" },
  "9:16": { w: 1080, h: 1920, label: "9:16 vertical frame" },
  "1:1": { w: 1080, h: 1080, label: "1:1 square frame" },
};

/**
 * Run the QC battery. `opts.videoDuration` is the render's measured duration
 * (ground truth); `opts.narrationSec` is the voiceover length for the sync
 * comparison. `opts.expectedAspect` matches the render mode's geometry
 * (slides mode ships 9:16). Never throws — a crashed check reports as failed.
 */
export async function runQcReport(opts: {
  mp4Path: string;
  videoDuration: number;
  narrationSec: number | null;
  srtPath: string | null;
  /** Designed black-dip windows (fadeblack transitions) exempt from the black-frame check. */
  expectedBlack?: [number, number][];
  /** Frame geometry this render was built for (default "16:9"). */
  expectedAspect?: QcAspect;
  /** Stage 5 pacing gate: the APPROVED shot plan (null / absent = no plan).
   * Only approved plans reach the render, so callers pass null for
   * proposed/dismissed ones — a plan that never touched the pipeline must
   * not fail its QC. */
  shotPlan?: DirectorPlan | null;
  /** Render-mode blanket motion exemptions: an "animated" (i2v) or "stock"
   * render moves every scene regardless of plan flags. */
  shotPlanI2VEverywhere?: boolean;
  shotPlanStockEverywhere?: boolean;
  /** S36 continuity lens — where the assembled timeline says cuts and blend
   * windows sit on the blended clock. null/absent = no reconstruction
   * possible (doc-less re-run) → the check reports "unmeasured", never
   * clean. A single-scene render passes { cuts: [], windows: [] }: any
   * detected cut is then a genuine continuity break. */
  expectedCuts?: ExpectedCuts | null;
  /** Frame rate the render shipped at (stutter lens); default 30. */
  frameRate?: number;
  /** S49 — the restricted-visual scan outcome (restricted-subjects.ts
   *  runRestrictedVisualScan). Provided ONLY under a restricted content
   *  policy — the caller owns the decision (and the fail-closed rule: a
   *  policy-mode scan that could not run reports "unmeasured", never
   *  silence). Absent (standard policy) = the check is not emitted, exactly
   *  as before S49. */
  restrictedScan?: { status: "pass" | "fail" | "unmeasured"; value: string; detail?: string };
  /** S53 — the subject-continuity scan outcome (visual-qc.ts
   *  runSubjectContinuityScan). Provided ONLY when the video has a recurring
   *  cast with an identity anchor (the caller owns applicability). The S51
   *  benchmark's color-under-lighting finding lands here: lighting-induced
   *  hue drift reads in the notes, only identity-defining drift fails.
   *  Absent = the check is not emitted (no cast, no continuity domain). */
  subjectScan?: { status: "pass" | "fail" | "unmeasured"; value: string; detail?: string };
  /** S53 — the text-artifacts scan outcome (visual-qc.ts
   *  runTextArtifactScan). Provided for every render (AI imagery is the
   *  product; gibberish pseudo-text and watermarks are its classic defect).
   *  Deliberate burned captions are excluded by the judge's contract.
   *  Absent = the check is not emitted (e.g. a pre-S53 caller). */
  textScan?: { status: "pass" | "fail" | "unmeasured"; value: string; detail?: string };
  /** S123 (G1) P3 — the graphics lane's DESIGNED hold windows (graphics/
   *  qc.ts graphicsHoldWindows — the doc's legal post-motion holds, in
   *  absolute seconds). A sampled static run STARTING inside a window is
   *  the kinetic-typography design, not a defect; starting elsewhere is a
   *  dead compositor. Absent (every other lane) = the byte-identical
   *  pre-S123 judgment. */
  designedFreezes?: [number, number][];
  /** S123 (G1) P5 — the graphics lane's frozen-frames semantics switch:
   *  freezedetect's per-frame noise floor cannot see small kinetic motion
   *  (the P5 proof's recorded finding), so the lane judges DEAD-COMPOSITOR
   *  coverage instead (judgeGraphicsFreezes) and the sampled static-shots
   *  lens carries the in-scene truth. Absent = the pre-S123 judgment. */
  graphicsLane?: boolean;
  /** S123 (G1) P5 — the graphics lane's scene-cut threshold calibration:
   *  the format's hard cuts can be a subtle background-tone swap (~0.03
   *  scene score), far below the story lanes' 0.40. The calibrated floor
   *  (0.025) still sits ABOVE the format's in-scene per-frame motion
   *  (≤ ~0.015 — the P5 proof's recorded finding). Absent = 0.40. */
  sceneCutThreshold?: number;
}): Promise<QcReport> {
  const aspect: QcAspect =
    opts.expectedAspect === "9:16" ? "9:16" : opts.expectedAspect === "1:1" ? "1:1" : "16:9";
  const aspectSpec = ASPECT_TARGET[aspect];
  const checks: QcCheck[] = [];
  const exists = fs.existsSync(opts.mp4Path);
  const expectedBlack = opts.expectedBlack ?? [];

  const isDesignedBlack = (start: number): boolean =>
    expectedBlack.some(([lo, hi]) => start >= lo - 0.1 && start <= hi + 0.1);

  // 1) Playability — streams + duration readable. S136 — the audio half is
  //    judged against the render's OWN audio contract, not a blanket demand:
  //    a narrated render must carry its speech (missing AAC = words cut —
  //    blocking, the −34 s class), while a SILENT DRAFT is legal as a
  //    video-only MP4 (the lanes' documented silent-draft law — a fully
  //    silent project ships video-only scene encodes and a stream-copy
  //    assembly; music may join at the bed, so AAC stays acceptable either
  //    way). The old unconditional AAC demand shipped a BLOCKING playable=
  //    fail on every silent draft — whiteboard and graphics alike — holding
  //    perfectly playable exports behind a false finding (caught by the
  //    S136 e2e QC-verdict pin, CI #324/#325 + the live row evidence).
  let duration = opts.videoDuration;
  let dimensions: { width?: number; height?: number } | null = null;
  const narrated = opts.narrationSec != null && opts.narrationSec > 0;
  // Any audio stream at all (any codec — the measurement lenses decode
  // whatever ships; the AAC strictness stays playable-check-local).
  let hasAudioStream = false;
  // The applicability law is honest only over a MEASURED stream layout: an
  // ffprobe that FAILED knows nothing — applicability there stays TRUE
  // (fail-closed, the garbage-bytes law: failed analysis → unmeasured,
  // never a lens silently dropped).
  let probeClean = false;
  if (exists) {
    try {
      const info = await ffprobeJson(opts.mp4Path);
      probeClean = true;
      const hasVideo = Boolean(info.streams?.some((s) => s.codec_type === "video" && s.codec_name === "h264"));
      hasAudioStream = info.streams?.some((s) => s.codec_type === "audio") ?? false;
      const hasAudio = Boolean(info.streams?.some((s) => s.codec_type === "audio" && s.codec_name === "aac"));
      const probed = Number(info.format?.duration ?? 0);
      if (Number.isFinite(probed) && probed > 0) duration = probed;
      dimensions = info.streams?.find((s) => s.codec_type === "video") ?? null;
      const playable = hasVideo && (hasAudio || !narrated);
      checks.push(
        check(
          "playable",
          narrated
            ? "Plays as a valid MP4 (H.264 video + AAC audio)"
            : "Plays as a valid MP4 (H.264 video; a silent draft may ship video-only)",
          playable ? "pass" : "fail",
          playable
            ? hasAudio
              ? `${duration.toFixed(1)}s readable`
              : `${duration.toFixed(1)}s readable (video-only silent draft)`
            : hasVideo
              ? "stream missing"
              : "no H.264 video stream"
        )
      );
    } catch (err) {
      checks.push(
        check("playable", "Plays as a valid MP4", "fail", "ffprobe failed", String(err).slice(0, 200))
      );
    }
  } else {
    checks.push(check("playable", "Output file exists", "fail", "final.mp4 missing"));
  }

  // S136 — the audio lenses' APPLICABILITY law. A lens that measures sound
  // runs only when the artifact carries a stream to measure, or when the
  // contract demands one (narrated — fail-closed: missing evidence stays
  // unmeasured, never clean). A silent draft's video-only file has nothing
  // to grade: the audio lenses are NOT APPLICABLE there — the same
  // contract-scoped emission the narration-sync check already follows
  // ("absent contract = the check is not emitted") — never unmeasured
  // noise, and never a spurious dead-air "pass" over a file with no audio
  // at all. The video lenses (black/frozen/aspect/static/flicker/stutter)
  // are unaffected: the shared analysis pass still runs for them.
  const audioApplicable = !probeClean || hasAudioStream || narrated;

  // 2) Duration vs narration — audio/video sync sanity.
  if (opts.narrationSec && opts.narrationSec > 0) {
    const drift = duration - opts.narrationSec;
    // Asymmetric tolerance: the video may run LONGER than the narration
    // (scene lead-ins, holds, dramatic pauses — up to +20%), but never
    // meaningfully SHORTER. A video shorter than its narration means words
    // were cut mid-sentence — the −34 s Battle Yamuk class — and must fail
    // hard, not ride a ±20% band.
    const tolerance = Math.max(8, opts.narrationSec * 0.2);
    checks.push(
      check(
        "duration",
        "Video length matches the narration",
        drift >= -2 && drift <= tolerance ? "pass" : "fail",
        `video ${duration.toFixed(1)}s vs narration ${opts.narrationSec.toFixed(1)}s`,
        `drift ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}s (tolerance ±${tolerance.toFixed(0)}s — scene lead-ins add a few seconds)`
      )
    );
  }

  if (exists) {
    // 3–6) Combined analysis pass. A crash here (ok=false) leaves partial
    // stderr — every detector below MUST answer "unmeasured", not "clean".
    const analysis = await analyzePass(opts.mp4Path);
    const stderr = analysis.stderr;
    const analysisRan = analysis.ok;

    // ffmpeg 7.x prefixes these log lines with the frame-metadata key
    // ("lavfi.blackdetect.") and varies the spacing after the colon — the
    // pattern tolerates both so the check works across ffmpeg versions.
    // 2026-11-18: ffmpeg 8 changed the log prefix itself — [blackdetect @ …]
    // became [Parsed_blackdetect_0 @ …] — so the bracket class no longer
    // anchors on the filter name alone; match ANY bracket that CONTAINS the
    // filter name (8.1.3-static CI evidence: dead-air false-passed every
    // render before this fix).
    const blacks = [...stderr.matchAll(/\[[^\]]*blackdetect[^\]]*\]\s*(?:lavfi\.blackdetect\.)?black_start:\s*(\d+(?:\.\d+)?)/g)]
      .map((m) => Number(m[1]));
    const unexpected = blacks.filter((t) => !isDesignedBlack(t));
    if (!analysisRan) {
      checks.push(
        check("black-frames", "No unexplained black frames", "unmeasured", "analysis failed",
          "ffmpeg could not complete the scan — this check did not run")
      );
    } else {
      checks.push(
        check(
          "black-frames",
          "No unexplained black frames",
          unexpected.length === 0 ? "pass" : "fail",
          unexpected.length === 0
            ? blacks.length > expectedBlack.length
              ? `${expectedBlack.length} designed transition dip${expectedBlack.length === 1 ? "" : "s"} only`
              : "none detected"
            : `${unexpected.length} unexplained interval${unexpected.length > 1 ? "s" : ""}`,
          unexpected.slice(0, 5).map((s) => `at ${s}s`).join(", ") ||
            (blacks.length ? `all ${blacks.length} inside designed fadeblack windows` : "")
        )
      );
    }

    // freezedetect emits the start + the duration of every freeze run —
    // the graphics lane's coverage judgment needs the EVENTS, not just the
    // starts.
    const freezeEvents = [...stderr.matchAll(
      /\[[^\]]*freezedetect[^\]]*\]\s*(?:lavfi\.freezedetect\.)?freeze_start:\s*(\d+(?:\.\d+)?)[\s\S]*?\[[^\]]*freezedetect[^\]]*\]\s*(?:lavfi\.freezedetect\.)?freeze_duration:\s*(\d+(?:\.\d+)?)/g
    )].map((m) => ({ startSec: Number(m[1]), endSec: Number(m[1]) + Number(m[2]) }));
    const freezes = freezeEvents.map((e) => e.startSec);
    // S123 — the lane split: the graphics lane judges DEAD-COMPOSITOR
    // coverage (its noise-floor finding is recorded in judgeGraphicsFreezes);
    // every other lane keeps the designed-window judgment verbatim.
    const freezeSplit = opts.graphicsLane
      ? judgeGraphicsFreezes(freezeEvents, duration)
      : judgeFreezes(freezes, opts.designedFreezes ?? []);
    if (!analysisRan) {
      checks.push(
        check("frozen-frames", "No frozen imagery (motion everywhere)", "unmeasured", "analysis failed",
          "ffmpeg could not complete the scan — this check did not run")
      );
    } else {
      checks.push(
        check(
          "frozen-frames",
          "No frozen imagery (motion everywhere)",
          freezeSplit.unexpected.length === 0 ? "pass" : "fail",
          freezeSplit.unexpected.length === 0
            ? freezes.length === 0
              ? "none detected"
              : `${freezeSplit.designedCount} designed freeze${freezeSplit.designedCount === 1 ? "" : "s"} only`
            : `${freezeSplit.unexpected.length} frozen run${freezeSplit.unexpected.length > 1 ? "s" : ""}`,
          freezeSplit.unexpected.length === 0
            ? freezes.length > 0
              ? opts.graphicsLane
                ? "sub-noise events below the dead-compositor coverage — the sampled static lens carries the in-scene truth (graphics lane)"
                : "all inside the doc's designed hold windows (graphics lane)"
              : ""
            : freezeSplit.unexpected.slice(0, 4).map((s) => `at ${s}s`).join(", ")
        )
      );
    }

    if (dimensions?.width && dimensions?.height) {
      const ratio = dimensions.width / dimensions.height;
      const [tw, th] = [aspectSpec.w, aspectSpec.h];
      const ok = Math.abs(ratio - tw / th) <= 0.02;
      checks.push(
        check(
          "aspect",
          `${aspectSpec.label} (no squeeze/crop defects)`,
          ok ? "pass" : "fail",
          `${dimensions.width}x${dimensions.height}`
        )
      );
    }

    const maxVol = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    const samplePeak = maxVol ? Number(maxVol[1]) : null;

    // 3–7) Loudness family — one loudnorm analysis pass (I / true peak / LRA)
    // replaces the old ebur128 + volumedetect pair, and measures TRUE peak
    // (inter-sample), not just the sample peak. Applicability-gated (S136):
    // nothing to measure on a video-only silent draft — no doomed run, no
    // unmeasured noise.
    const lm = audioApplicable ? await measureLoudness(opts.mp4Path) : null;
    if (audioApplicable) checks.push(
      check(
        "loudness",
        `Broadcast loudness (${MIX_TARGETS.integratedLUFS} LUFS target)`,
        lm === null
          ? "unmeasured"
          : lm.integratedLUFS >= LUFS_PASS_WINDOW[0] && lm.integratedLUFS <= LUFS_PASS_WINDOW[1] ? "pass" : "fail",
        lm === null ? "not measured" : `${lm.integratedLUFS.toFixed(1)} LUFS`,
        lm === null
          ? (samplePeak !== null ? `sample peak ${samplePeak.toFixed(1)} dBFS (loudness pass failed)` : "loudness analysis failed")
          : `window ${LUFS_PASS_WINDOW[0]}…${LUFS_PASS_WINDOW[1]} LUFS`
      )
    );
    if (audioApplicable) checks.push(
      check(
        "true-peak",
        "True peak ≤ -1 dBTP (no clipping after encode)",
        lm === null ? "unmeasured" : lm.truePeakDBTP <= MIX_TARGETS.truePeakDBTP + 0.2 ? "pass" : "fail",
        lm === null
          ? samplePeak === null ? "not measured" : `sample ${samplePeak.toFixed(1)} dBFS`
          : `${lm.truePeakDBTP.toFixed(1)} dBTP`,
        lm === null ? "loudness analysis failed" : "0.2 dB tolerance covers AAC inter-sample overshoot"
      )
    );
    if (audioApplicable) checks.push(
      check(
        "loudness-range",
        "Consistent volume (loudness range)",
        lm === null ? "unmeasured" : lm.lra <= LRA_WARN ? "pass" : "fail",
        lm === null ? "not measured" : `LRA ${lm.lra.toFixed(1)} LU`,
        lm === null ? "loudness analysis failed" : `flagged above ${LRA_WARN} LU`
      )
    );

    // Dead air: silence runs ≥1.5s fully inside the video (ignore lead-in/out).
    // Applicability-gated (S136): "no voice or music always present" has no
    // premise over an artifact with no audio stream at all — a silent
    // contract's video-only file neither passes nor fails this lens; it is
    // simply not asked.
    const silences = audioApplicable
      ? [...stderr.matchAll(/\[[^\]]*silencedetect[^\]]*\]\s*(?:lavfi\.silencedetect\.)?silence_start:\s*(\d+(?:\.\d+)?)/g)]
          .map((m) => Number(m[1]))
          .filter((s) => s > 1 && s < duration - 2)
      : [];
    if (!audioApplicable) {
      /* not applicable — the lens is not emitted on a stream-less silent artifact */
    } else if (!hasAudioStream) {
      // Narrated contract but the artifact carries no audio at all: playable
      // already carries the blocking finding (stream missing). Dead air stays
      // fail-closed honest here — unmeasured, never a spurious "pass: none"
      // over a file nothing could be heard from.
      checks.push(
        check("dead-air", "No dead air (voice or music always present)", "unmeasured", "no audio stream",
          "the artifact carries no audio — the scan has nothing to listen to")
      );
    } else if (!analysisRan) {
      checks.push(
        check("dead-air", "No dead air (voice or music always present)", "unmeasured", "analysis failed",
          "ffmpeg could not complete the scan — this check did not run")
      );
    } else {
      checks.push(
        check(
          "dead-air",
          "No dead air (voice or music always present)",
          silences.length === 0 ? "pass" : "fail",
          silences.length === 0 ? "none" : `${silences.length} silent run${silences.length > 1 ? "s" : ""}`,
          silences.slice(0, 4).map((s) => `at ${s.toFixed(1)}s`).join(", ")
        )
      );
    }

    // 8) Visual pacing — two lenses on the same defect class:
    //   (a) the APPROVED shot-plan's own rhythm (Stage 5 completion gate):
    //       3+ consecutive static shots with no motion / i2v / stock
    //       motivation is flat pacing — deterministic, knowable before a
    //       single pixel is measured;
    //   (b) the sampled visual-change scan (freezedetect above only catches
    //       EXACT freezes; a motionless Ken Burns crop or static stock clip
    //       reads as "nothing happens" while evading it).
    const planRuns = planStaticRuns(opts.shotPlan ?? null, {
      i2vEverywhere: opts.shotPlanI2VEverywhere,
      stockEverywhere: opts.shotPlanStockEverywhere,
    });
    const worstRun = planRuns.find((r) => r.length >= 3) ?? null;
    const staticPass = await detectStaticRuns(opts.mp4Path);
    // S123 — the designed-hold split rides the sampled scan too (the
    // graphics lane's legal holds; absent = the pre-S123 judgment).
    const staticSplit = judgeStaticRuns(staticPass.runs, opts.designedFreezes ?? []);
    const planFlat = worstRun !== null;
    checks.push(
      check(
        "static-shots",
        "Visual pacing — no long static stretches",
        planFlat
          ? "fail"
          : !staticPass.measured
            ? "unmeasured"
            : staticSplit.unexpected.length === 0
              ? "pass"
              : "fail",
        planFlat
          ? `${worstRun.length} flat shots in a row (scene${
              worstRun.fromScene === worstRun.toScene
                ? ` ${worstRun.fromScene}`
                : `s ${worstRun.fromScene}–${worstRun.toScene}`
            })`
          : !staticPass.measured
            ? "not measured"
            : staticSplit.unexpected.length === 0
              ? staticPass.runs.length === 0
                ? "visual change throughout"
                : `${staticSplit.designedCount} designed hold${staticSplit.designedCount === 1 ? "" : "s"} only`
              : `${staticSplit.unexpected.length} static run${staticSplit.unexpected.length > 1 ? "s" : ""}`,
        planFlat
          ? "approved direction holds these shots still with no motion, i2v or stock motivation — re-run the director with movement or set motion/animation on those scenes"
          : !staticPass.measured
            ? "the sampled scan could not run"
            : staticSplit.unexpected.length === 0
              ? staticPass.runs.length > 0
                ? "all inside the doc's designed hold windows (graphics lane)"
                : ""
              : staticRunsDetail(staticSplit.unexpected)
      )
    );

    // 9) S36 lenses — flicker, stutter, cut alignment. Each is a separate
    // probe with its own measured flag: one crashed lens must not silence
    // the others, and every unmeasured lens keeps the report red/amber.
    const flick = await detectFlicker(opts.mp4Path);
    checks.push(
      check(
        "flicker",
        "Steady brightness (no flicker or pumping)",
        !flick.measured
          ? "unmeasured"
          : flick.events.length === 0
            ? "pass"
            : "fail",
        !flick.measured
          ? "not measured"
          : flick.events.length === 0
            ? "none detected"
            : `${flick.events.length} pumping run${flick.events.length > 1 ? "s" : ""}`,
        !flick.measured
          ? "luma-sampling probe failed — this check did not run"
          : flick.events
              .slice(0, 4)
              .map((e) => `from ${e.startSec.toFixed(1)}s (${e.alternations} swings)`)
              .join(", ")
      )
    );

    const stut = await detectStutter(opts.mp4Path, opts.frameRate ?? 30);
    const stutterBad = stut.dupRuns.length > 0 || stut.gaps.length >= STUTTER_LIMITS.gapCountMin;
    checks.push(
      check(
        "stutter",
        "Even frame timing (no stutter)",
        !stut.measured
          ? "unmeasured"
          : stutterBad
            ? "fail"
            : "pass",
        !stut.measured
          ? "not measured"
          : stut.dupRuns.length === 0 && stut.gaps.length === 0
            ? "even timing throughout"
            : `${stut.dupRuns.length} duplicate-frame run${stut.dupRuns.length === 1 ? "" : "s"}, ${stut.gaps.length} timestamp gap${stut.gaps.length === 1 ? "" : "s"}`,
        !stut.measured
          ? "packet-timing probe failed — this check did not run"
          : [
              ...stut.dupRuns
                .slice(0, 3)
                .map((r) => `${r.frames} duplicated frames from ${r.startSec.toFixed(1)}s`),
              ...stut.gaps
                .slice(0, 3)
                .map((g) => `timing gap after ${g.toFixed(1)}s`),
            ].join(", ")
      )
    );

    if (opts.expectedCuts) {
      const sc = await detectSceneCuts(opts.mp4Path, opts.sceneCutThreshold);
      const aligned = sc.measured
        ? alignCuts(sc.cuts, opts.expectedCuts, CUT_TOL_SEC)
        : { unexpected: [], missing: [] };
      const cutBad = aligned.unexpected.length > 0 || aligned.missing.length > 0;
      checks.push(
        check(
          "cut-alignment",
          "Cuts land where the timeline says (continuity)",
          !sc.measured
            ? "unmeasured"
            : cutBad
              ? "fail"
              : "pass",
          !sc.measured
            ? "not measured"
            : cutBad
              ? `${aligned.unexpected.length} unexpected, ${aligned.missing.length} missing`
              : opts.expectedCuts.cuts.length === 0
                ? "no stray cuts"
                : `all ${opts.expectedCuts.cuts.length} cut${opts.expectedCuts.cuts.length === 1 ? "" : "s"} in place`,
          !sc.measured
            ? "scene-change probe failed — this check did not run"
            : [
                ...aligned.unexpected
                  .slice(0, 4)
                  .map((t) => `stray cut at ${t.toFixed(1)}s`),
                ...aligned.missing
                  .slice(0, 4)
                  .map((t) => `timeline cut missing at ${t.toFixed(1)}s`),
              ].join(", ")
        )
      );
    } else {
      checks.push(
        check(
          "cut-alignment",
          "Cuts land where the timeline says (continuity)",
          "unmeasured",
          "no timeline reconstruction",
          "this video has no aligned timeline doc — cuts cannot be checked"
        )
      );
    }

    // 7b) Abrupt ending — the final 0.4 s should sit in a fade/silence, not
    // mid-beat. Music beds fade out by design; a hard audio cut reads as a
    // glitch (and YouTube viewers notice). Applicability-gated (S136): an
    // audio tail cannot fade on an artifact with no audio stream.
    const tail = audioApplicable ? await tailVolume(opts.mp4Path, duration) : null;
    if (audioApplicable) checks.push(
      check(
        "tail-fade",
        "Ends on a fade, not an abrupt cut",
        tail === null ? "unmeasured" : tail <= -25 ? "pass" : "fail",
        tail === null ? "not measured" : `final 0.4s at ${tail.toFixed(1)} dB mean`,
        tail === null
          ? "final 0.4s unreadable or clip too short — fade state unknown"
          : "flagged above -25 dB mean"
      )
    );
  }

  // 8) Caption sanity — when an SRT ships alongside.
  if (opts.srtPath && fs.existsSync(opts.srtPath)) {
    try {
      const cues = parseSrt(fs.readFileSync(opts.srtPath, "utf8"));
      let monotonic = cues.length > 0;
      for (let i = 1; i < cues.length; i++) {
        if (cues[i].start < cues[i - 1].start - 0.01 || cues[i].start < cues[i - 1].end - 0.01) {
          monotonic = false;
          break;
        }
      }
      const inRange = cues.length === 0 || cues[cues.length - 1].end <= duration + 0.5;
      checks.push(
        check(
          "captions",
          "Captions timed to the video",
          cues.length > 0 && monotonic && inRange ? "pass" : "fail",
          `${cues.length} cues`,
          cues.length === 0 ? "empty SRT" : !monotonic ? "overlapping cues" : !inRange ? "cues run past the end" : "in order"
        )
      );
    } catch {
      checks.push(check("captions", "Captions timed to the video", "fail", "SRT unreadable"));
    }
  }

  // S49 — the restricted-visual check rides the report when (and only when)
  // the caller ran the policy scan. It counts toward `passed` like every
  // other check — a fail or unmeasured scan keeps the report red.
  if (opts.restrictedScan) {
    checks.push(
      check(
        "restricted-visual",
        "No depiction of restricted religious figures (content policy)",
        opts.restrictedScan.status,
        opts.restrictedScan.value,
        opts.restrictedScan.detail
      )
    );
  }

  // S53 — the advanced visual lenses ride the same law: emitted when (and
  // only when) the caller ran the scan, counting toward `passed` like every
  // other check (a fail or unmeasured scan keeps the report from reading
  // clean — the battery's own never-silently-clean contract).
  if (opts.subjectScan) {
    checks.push(
      check(
        "subject-continuity",
        "Recurring subject keeps one identity across scenes",
        opts.subjectScan.status,
        opts.subjectScan.value,
        opts.subjectScan.detail
      )
    );
  }
  if (opts.textScan) {
    checks.push(
      check(
        "text-artifacts",
        "No gibberish text or watermarks in the imagery",
        opts.textScan.status,
        opts.textScan.value,
        opts.textScan.detail
      )
    );
  }

  return {
    // The report is clean only when EVERY check actually ran AND passed —
    // an unmeasured check keeps the overall badge red/amber for a human.
    passed: checks.length > 0 && checks.every((c) => c.status === "pass"),
    checkedAt: new Date().toISOString(),
    durationSec: Math.round(duration * 10) / 10,
    checks,
  };
}

/** Standard QC for a rendered video (paths under uploads/<videoId>/). */
export async function qcForVideo(
  videoId: string,
  videoDuration: number,
  narrationSec: number | null,
  expectedBlack?: [number, number][],
  expectedAspect?: QcAspect,
  shotPlan?: DirectorPlan | null,
  pacingExemptions?: { i2vEverywhere?: boolean; stockEverywhere?: boolean },
  expectedCuts?: ExpectedCuts | null,
  frameRate?: number,
  restrictedScan?: { status: "pass" | "fail" | "unmeasured"; value: string; detail?: string },
  subjectScan?: { status: "pass" | "fail" | "unmeasured"; value: string; detail?: string },
  textScan?: { status: "pass" | "fail" | "unmeasured"; value: string; detail?: string },
  designedFreezes?: [number, number][],
  graphicsLane?: boolean,
  sceneCutThreshold?: number
): Promise<QcReport> {
  // Storage seam (T-3.7): ffprobe/readFile need real paths — materialize
  // returns the uploads path locally, a cached download under s3.
  const { materialize } = await import("./storage");
  return runQcReport({
    mp4Path: await materialize(`${videoId}/final.mp4`),
    videoDuration,
    narrationSec,
    srtPath: await materialize(`${videoId}/subtitles.srt`),
    expectedBlack,
    expectedAspect,
    shotPlan,
    shotPlanI2VEverywhere: pacingExemptions?.i2vEverywhere,
    shotPlanStockEverywhere: pacingExemptions?.stockEverywhere,
    expectedCuts,
    frameRate,
    restrictedScan,
    subjectScan,
    textScan,
    designedFreezes,
    graphicsLane,
    sceneCutThreshold,
  });
}

/**
 * S45 — scoped QC for a PREVIEW render (the first N scenes, preview.mp4).
 * Mirrors qcForVideo with preview-honest expectations:
 *   • no narration-sync check — the preview is a partial artifact; its
 *     "narration" is scenes 1..N, which no single field carries;
 *   • no captions check — no SRT ships for previews (the burned captions,
 *     if on, are measured by the visual lenses like any other pixels);
 *   • every artifact-local lens (playable, black/frozen frames, aspect,
 *     loudness family, dead air, static, flicker, stutter, cut alignment,
 *     tail fade) runs exactly as for a full render.
 * The report carries scope "preview" so qc-policy can refuse to treat it
 * as evidence for the final artifact, and the render job persists it ONLY
 * while no full render stands (preview evidence never overwrites full
 * evidence — the export gate must never judge final.mp4 on a scene-1 file).
 */
export async function qcForPreview(
  videoId: string,
  videoDuration: number,
  expectedBlack?: [number, number][],
  expectedAspect?: QcAspect,
  shotPlan?: DirectorPlan | null,
  pacingExemptions?: { i2vEverywhere?: boolean; stockEverywhere?: boolean },
  expectedCuts?: ExpectedCuts | null,
  frameRate?: number
): Promise<QcReport> {
  const { materialize } = await import("./storage");
  const report = await runQcReport({
    mp4Path: await materialize(`${videoId}/preview.mp4`),
    videoDuration,
    narrationSec: null,
    srtPath: null,
    expectedBlack,
    expectedAspect,
    shotPlan,
    shotPlanI2VEverywhere: pacingExemptions?.i2vEverywhere,
    shotPlanStockEverywhere: pacingExemptions?.stockEverywhere,
    expectedCuts,
    frameRate,
  });
  return { ...report, scope: "preview" };
}
