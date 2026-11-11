// S89 (ROADMAP #8, S76 §5 P2) — the stock clip verifier. The pre-S89 gate
// extracted ONE frame at t=1s, asked the VLM once, and failed open silently.
// S76: "the stronger implementation samples multiple frames per clip instead
// of trusting one" — this module is that:
//
//   • ffprobe the REAL duration, sample interior frames (stockFrameTimes)
//   • judge frames SEQUENTIALLY with early exit — a clearly relevant clip
//     stops at 2 passing frames, garbage stops at 2 failing frames, a VLM
//     outage stops after 2 unchecked frames. The multi-frame evidence
//     without 3× the VLM spend on every clip.
//   • MOTION, measured not guessed: the mean luma difference between the
//     first and last sampled frame (ffmpeg blend=difference + signalstats).
//     A frozen frame in an mp4 is the art lane's job, not b-roll.
//   • the combination (stock-ranker.combineFrameVerdicts) is the pure,
//     pinned reducer; this module only gathers evidence.
//
// The relevance function is INJECTABLE: production wires quality.ts's
// relevanceCheck (the gate threshold reuse is unchanged); the offline smoke
// and unit pins inject deterministic fakes — the ffmpeg/probe/motion paths
// run for real either way.

import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { relevanceCheck } from "./quality";
import { combineFrameVerdicts, stockFrameTimes, type CombinedVerdict } from "./stock-ranker";
import type { Scene } from "./types";

const execFileAsync = promisify(execFile);

const FFMPEG_TIMEOUT_MS = 30_000;
const FFMPEG_MAX_BUFFER = 4 * 1024 * 1024;

/** The relevance gate seam (quality.relevanceCheck's shape). */
export type RelevanceFn = (
  imagePath: string,
  context: string
) => Promise<{ pass: boolean | null; score: number | null; summary: string | null }>;

export interface VerifyOutcome extends CombinedVerdict {
  motionDelta: number | null;
  scores: (number | null)[];
  summaries: (string | null)[];
}

/** ffprobe the clip's real duration (seconds); null when unprobed. */
export async function probeDuration(clipPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", clipPath],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER }
    );
    const dur = Number(JSON.parse(stdout)?.format?.duration);
    return Number.isFinite(dur) && dur > 0 ? dur : null;
  } catch {
    return null;
  }
}

/** Extract one 640px-wide frame at `timeSec` (null when extraction fails). */
async function extractFrame(
  clipPath: string,
  timeSec: number,
  framePath: string
): Promise<boolean> {
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-ss", timeSec.toFixed(2),
        "-i", clipPath,
        "-frames:v", "1",
        "-vf", "scale=640:-2",
        "-y", framePath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER }
    );
    return fs.existsSync(framePath) && fs.statSync(framePath).size > 1000;
  } catch {
    return false;
  }
}

/**
 * Mean luma difference (0-255) between two same-sized frames — the
 * deterministic motion measurement. blend=difference then signalstats YAVG.
 * Null when ffmpeg fails (the caller ignores motion, never rejects on it).
 */
export async function measureMotionDelta(
  frameA: string,
  frameB: string
): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-i", frameA,
        "-i", frameB,
        "-filter_complex",
        "[0:v][1:v]blend=all_mode=difference,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
        "-f", "null", "-",
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER }
    );
    const m = /YAVG=([0-9]+\.?[0-9]*)/.exec(stdout);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Verify one DOWNLOADED clip for one scene. Never throws — every failure
 * degrades to the unverified outcome (pass:null), exactly like the pre-S89
 * gate, except now the evidence basis is recorded on the ref.
 */
export async function verifyClip(opts: {
  clipPath: string;
  /** Duration fallback when ffprobe fails (the provider's metadata). */
  durationSec: number;
  scene: Scene;
  /** Production default: quality.relevanceCheck. Tests inject fakes. */
  relevance?: RelevanceFn;
}): Promise<VerifyOutcome> {
  const relevance = opts.relevance ?? relevanceCheck;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tf-stock-verify-"));
  try {
    const duration =
      (await probeDuration(opts.clipPath)) ??
      (opts.durationSec > 0 ? opts.durationSec : 0);
    const times = stockFrameTimes(duration);
    if (times.length === 0)
      return unverified("clip duration unknown — no frames sampled");

    // Extract every sample frame upfront (cheap); the expensive VLM calls
    // below are the ones that exit early.
    const frames: string[] = [];
    for (const [i, t] of times.entries()) {
      const framePath = path.join(scratch, `frame-${i}.jpg`);
      if (await extractFrame(opts.clipPath, t, framePath)) frames.push(framePath);
    }
    if (frames.length === 0)
      return unverified("no frames could be extracted from the clip");

    const context =
      `stock b-roll for scene ${opts.scene.index} "${opts.scene.title}" of a story video — ` +
      `the clip must show: ${opts.scene.visual} ` +
      `(mood: ${opts.scene.mood}; narration at this moment: "${opts.scene.narration.slice(0, 140)}")`;

    // Sequential judging with early exit: 2 passes → accept evidence done,
    // 2 fails → reject evidence done, 2 unchecked + 0 checked → the VLM is
    // down, stop spending frames on it.
    const verdicts: (boolean | null)[] = [];
    const scores: (number | null)[] = [];
    const summaries: (string | null)[] = [];
    for (const frame of frames) {
      let pass: boolean | null = null;
      let score: number | null = null;
      let summary: string | null = null;
      try {
        const v = await relevance(frame, context);
        pass = v.pass;
        score = v.score;
        summary = v.summary;
      } catch {
        /* one frame's gate failure never rejects the clip */
      }
      verdicts.push(pass);
      scores.push(score);
      summaries.push(summary);
      const p = verdicts.filter((x) => x === true).length;
      const f = verdicts.filter((x) => x === false).length;
      const n = verdicts.filter((x) => x === null).length;
      if (p >= 2 || f >= 2 || (n >= 2 && p + f === 0)) break;
    }

    // Motion between the first and last EXTRACTED frame — independent of the
    // judging early exit, so a relevant-but-frozen clip is still caught.
    const motionDelta =
      frames.length >= 2 ? await measureMotionDelta(frames[0], frames[frames.length - 1]) : null;

    const combined = combineFrameVerdicts(verdicts, motionDelta);
    return { ...combined, motionDelta, scores, summaries };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function unverified(reason: string): VerifyOutcome {
  const combined = combineFrameVerdicts([], null);
  return { ...combined, reason, motionDelta: null, scores: [], summaries: [] };
}
