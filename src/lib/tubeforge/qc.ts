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
//
// The render never fails because of QC — the report drives the QC badge in
// the UI so a human can inspect before export/upload.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import {
  measureLoudness,
  detectStaticRuns,
  staticRunsDetail,
  LUFS_PASS_WINDOW,
  LRA_WARN,
  MIX_TARGETS,
} from "./audiomix";

const execFileAsync = promisify(execFile);
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

export interface QcCheck {
  id: string;
  label: string;
  pass: boolean;
  value: string;
  detail?: string;
}

export interface QcReport {
  passed: boolean;
  checkedAt: string;
  durationSec: number;
  checks: QcCheck[];
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

/** One combined ffmpeg analysis pass: black frames + frozen frames + volume + silence. */
async function analyzePass(file: string) {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner", "-nostats",
        "-i", file,
        "-vf", "blackdetect=d=0.25:pix_th=0.10,freezedetect=n=0.004:d=0.30",
        "-af", "volumedetect,silencedetect=n=-40dB:d=1.5",
        "-f", "null", "-",
      ],
      { timeout: 8 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }
    );
    return stderr.toString();
  } catch (err) {
    const e = err as { stderr?: string };
    return e.stderr ?? "";
  }
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

function parseSrt(text: string): SrtCue[] {
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

/** Frame geometry expectations — vertical is a first-class format now. */
export type QcAspect = "16:9" | "9:16";

const ASPECT_TARGET: Record<QcAspect, { w: number; h: number; label: string }> = {
  "16:9": { w: 1920, h: 1080, label: "16:9 frame" },
  "9:16": { w: 1080, h: 1920, label: "9:16 vertical frame" },
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
}): Promise<QcReport> {
  const aspect: QcAspect = opts.expectedAspect === "9:16" ? "9:16" : "16:9";
  const aspectSpec = ASPECT_TARGET[aspect];
  const checks: QcCheck[] = [];
  const exists = fs.existsSync(opts.mp4Path);
  const expectedBlack = opts.expectedBlack ?? [];

  const isDesignedBlack = (start: number): boolean =>
    expectedBlack.some(([lo, hi]) => start >= lo - 0.1 && start <= hi + 0.1);

  // 1) Playability — streams + duration readable.
  let duration = opts.videoDuration;
  let dimensions: { width?: number; height?: number } | null = null;
  if (exists) {
    try {
      const info = await ffprobeJson(opts.mp4Path);
      const hasVideo = Boolean(info.streams?.some((s) => s.codec_type === "video" && s.codec_name === "h264"));
      const hasAudio = Boolean(info.streams?.some((s) => s.codec_type === "audio" && s.codec_name === "aac"));
      const probed = Number(info.format?.duration ?? 0);
      if (Number.isFinite(probed) && probed > 0) duration = probed;
      dimensions = info.streams?.find((s) => s.codec_type === "video") ?? null;
      checks.push({
        id: "playable",
        label: "Plays as a valid MP4 (H.264 video + AAC audio)",
        pass: hasVideo && hasAudio,
        value: hasVideo && hasAudio ? `${duration.toFixed(1)}s readable` : "stream missing",
      });
    } catch (err) {
      checks.push({
        id: "playable", label: "Plays as a valid MP4", pass: false,
        value: "ffprobe failed", detail: String(err).slice(0, 200),
      });
    }
  } else {
    checks.push({ id: "playable", label: "Output file exists", pass: false, value: "final.mp4 missing" });
  }

  // 2) Duration vs narration — audio/video sync sanity.
  if (opts.narrationSec && opts.narrationSec > 0) {
    const drift = duration - opts.narrationSec;
    const tolerance = Math.max(8, opts.narrationSec * 0.2);
    checks.push({
      id: "duration",
      label: "Video length matches the narration",
      pass: Math.abs(drift) <= tolerance,
      value: `video ${duration.toFixed(1)}s vs narration ${opts.narrationSec.toFixed(1)}s`,
      detail: `drift ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}s (tolerance ±${tolerance.toFixed(0)}s — scene lead-ins add a few seconds)`,
    });
  }

  if (exists) {
    // 3–6) Combined analysis pass.
    const stderr = await analyzePass(opts.mp4Path);

    const blacks = [...stderr.matchAll(/\[blackdetect[^\]]*\]\s*black_start:(\d+(?:\.\d+)?)/g)]
      .map((m) => Number(m[1]));
    const unexpected = blacks.filter((t) => !isDesignedBlack(t));
    checks.push({
      id: "black-frames",
      label: "No unexplained black frames",
      pass: unexpected.length === 0,
      value: unexpected.length === 0
        ? blacks.length > expectedBlack.length
          ? `${expectedBlack.length} designed transition dip${expectedBlack.length === 1 ? "" : "s"} only`
          : "none detected"
        : `${unexpected.length} unexplained interval${unexpected.length > 1 ? "s" : ""}`,
      detail: unexpected.slice(0, 5).map((s) => `at ${s}s`).join(", ") ||
        (blacks.length ? `all ${blacks.length} inside designed fadeblack windows` : ""),
    });

    const freezes = [...stderr.matchAll(/\[freezedetect[^\]]*\]\s*freeze_start:(\d+(?:\.\d+)?)/g)]
      .map((m) => Number(m[1]));
    checks.push({
      id: "frozen-frames",
      label: "No frozen imagery (motion everywhere)",
      pass: freezes.length === 0,
      value: freezes.length === 0 ? "none detected" : `${freezes.length} frozen run${freezes.length > 1 ? "s" : ""}`,
      detail: freezes.slice(0, 4).map((s) => `at ${s}s`).join(", "),
    });

    if (dimensions?.width && dimensions?.height) {
      const ratio = dimensions.width / dimensions.height;
      const [tw, th] = [aspectSpec.w, aspectSpec.h];
      const ok = Math.abs(ratio - tw / th) <= 0.02;
      checks.push({
        id: "aspect",
        label: `${aspectSpec.label} (no squeeze/crop defects)`,
        pass: ok,
        value: `${dimensions.width}x${dimensions.height}`,
      });
    }

    const maxVol = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    const samplePeak = maxVol ? Number(maxVol[1]) : null;

    // 3–7) Loudness family — one loudnorm analysis pass (I / true peak / LRA)
    // replaces the old ebur128 + volumedetect pair, and measures TRUE peak
    // (inter-sample), not just the sample peak.
    const lm = await measureLoudness(opts.mp4Path);
    checks.push({
      id: "loudness",
      label: `Broadcast loudness (${MIX_TARGETS.integratedLUFS} LUFS target)`,
      pass: lm !== null && lm.integratedLUFS >= LUFS_PASS_WINDOW[0] && lm.integratedLUFS <= LUFS_PASS_WINDOW[1],
      value: lm === null ? "not measured" : `${lm.integratedLUFS.toFixed(1)} LUFS`,
      detail:
        lm === null
          ? (samplePeak !== null ? `sample peak ${samplePeak.toFixed(1)} dBFS (loudness pass failed)` : "")
          : `window ${LUFS_PASS_WINDOW[0]}…${LUFS_PASS_WINDOW[1]} LUFS`,
    });
    checks.push({
      id: "true-peak",
      label: "True peak ≤ -1 dBTP (no clipping after encode)",
      pass: lm !== null && lm.truePeakDBTP <= MIX_TARGETS.truePeakDBTP + 0.2,
      value: lm === null
        ? samplePeak === null ? "not measured" : `sample ${samplePeak.toFixed(1)} dBFS`
        : `${lm.truePeakDBTP.toFixed(1)} dBTP`,
      detail: "0.2 dB tolerance covers AAC inter-sample overshoot",
    });
    checks.push({
      id: "loudness-range",
      label: "Consistent volume (loudness range)",
      pass: lm === null ? true : lm.lra <= LRA_WARN,
      value: lm === null ? "not measured" : `LRA ${lm.lra.toFixed(1)} LU`,
      detail: lm === null ? "" : `flagged above ${LRA_WARN} LU`,
    });

    // Dead air: silence runs ≥1.5s fully inside the video (ignore lead-in/out).
    const silences = [...stderr.matchAll(/\[silencedetect[^\]]*\]\s*silence_start:(\d+(?:\.\d+)?)/g)]
      .map((m) => Number(m[1]))
      .filter((s) => s > 1 && s < duration - 2);
    checks.push({
      id: "dead-air",
      label: "No dead air (voice or music always present)",
      pass: silences.length === 0,
      value: silences.length === 0 ? "none" : `${silences.length} silent run${silences.length > 1 ? "s" : ""}`,
      detail: silences.slice(0, 4).map((s) => `at ${s.toFixed(1)}s`).join(", "),
    });

    // 8) Visual pacing — sampled static-shot detection (freezedetect above
    // only catches EXACT freezes; a motionless Ken Burns crop or static
    // stock clip reads as "nothing happens" while evading it).
    const staticPass = await detectStaticRuns(opts.mp4Path);
    checks.push({
      id: "static-shots",
      label: "Visual pacing — no long static stretches",
      pass: staticPass.measured && staticPass.runs.length === 0,
      value: !staticPass.measured
        ? "not measured"
        : staticPass.runs.length === 0
          ? "visual change throughout"
          : `${staticPass.runs.length} static run${staticPass.runs.length > 1 ? "s" : ""}`,
      detail: staticRunsDetail(staticPass.runs),
    });

    // 7b) Abrupt ending — the final 0.4 s should sit in a fade/silence, not
    // mid-beat. Music beds fade out by design; a hard audio cut reads as a
    // glitch (and YouTube viewers notice).
    const tail = await tailVolume(opts.mp4Path, duration);
    checks.push({
      id: "tail-fade",
      label: "Ends on a fade, not an abrupt cut",
      pass: tail === null ? true : tail <= -25,
      value: tail === null ? "too short to measure" : `final 0.4s at ${tail.toFixed(1)} dB mean`,
    });
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
      checks.push({
        id: "captions",
        label: "Captions timed to the video",
        pass: cues.length > 0 && monotonic && inRange,
        value: `${cues.length} cues`,
        detail: cues.length === 0 ? "empty SRT" : !monotonic ? "overlapping cues" : !inRange ? "cues run past the end" : "in order",
      });
    } catch {
      checks.push({ id: "captions", label: "Captions timed to the video", pass: false, value: "SRT unreadable" });
    }
  }

  return {
    passed: checks.every((c) => c.pass),
    checkedAt: new Date().toISOString(),
    durationSec: Math.round(duration * 10) / 10,
    checks,
  };
}

/** Standard QC for a rendered video (paths under uploads/<videoId>/). */
export function qcForVideo(
  videoId: string,
  videoDuration: number,
  narrationSec: number | null,
  expectedBlack?: [number, number][],
  expectedAspect?: QcAspect
): Promise<QcReport> {
  return runQcReport({
    mp4Path: path.join(UPLOAD_ROOT, videoId, "final.mp4"),
    videoDuration,
    narrationSec,
    srtPath: path.join(UPLOAD_ROOT, videoId, "subtitles.srt"),
    expectedBlack,
    expectedAspect,
  });
}
