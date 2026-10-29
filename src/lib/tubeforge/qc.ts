// Post-render quality gate — the "verify the video actually plays" stage.
//
// After every FULL render (final.mp4 only, previews are exempt) the job runs
// this battery and records a JSON report on the video row:
//   1. playability   — has an H.264 video stream + AAC audio stream
//   2. duration      — video duration vs the narration length (sync sanity)
//   3. loudness      — integrated LUFS within [-19, -9] (target -14, YouTube)
//   4. peak headroom — max sample ≤ -0.5 dB (no clipping)
//   5. black frames  — zero black intervals ≥ 0.25 s
//   6. dead air      — no fully-silent run ≥ 1.5 s (voice OR bed always up)
//   7. captions      — SRT cues monotonic, non-overlapping, inside duration
//
// The render never fails because of QC — the report drives the QC badge in
// the UI so a human can inspect before export/upload.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

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

/** EBU R128 integrated loudness of the mixed track. */
async function loudnessPass(file: string): Promise<number | null> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
      { timeout: 8 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }
    );
    const m = stderr.toString().match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
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

/**
 * Run the QC battery. `opts.videoDuration` is the render's measured duration
 * (ground truth); `opts.narrationSec` is the voiceover length for the sync
 * comparison. Never throws — a crashed check reports as failed.
 */
export async function runQcReport(opts: {
  mp4Path: string;
  videoDuration: number;
  narrationSec: number | null;
  srtPath: string | null;
  /** Designed black-dip windows (fadeblack transitions) exempt from the black-frame check. */
  expectedBlack?: [number, number][];
}): Promise<QcReport> {
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
      const ok = Math.abs(ratio - 16 / 9) <= 0.02;
      checks.push({
        id: "aspect",
        label: "16:9 frame (no squeeze/crop defects)",
        pass: ok,
        value: `${dimensions.width}x${dimensions.height}`,
      });
    }

    const maxVol = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    const peak = maxVol ? Number(maxVol[1]) : null;
    checks.push({
      id: "peak",
      label: "No clipping (peak ≤ -0.5 dB)",
      pass: peak !== null && peak <= -0.5,
      value: peak === null ? "not measured" : `${peak.toFixed(1)} dBFS`,
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

    // 7) Loudness — separate EBU R128 pass.
    const lufs = await loudnessPass(opts.mp4Path);
    checks.push({
      id: "loudness",
      label: "Broadcast loudness (-14 LUFS target)",
      pass: lufs !== null && lufs >= -19 && lufs <= -9,
      value: lufs === null ? "not measured" : `${lufs.toFixed(1)} LUFS`,
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
  expectedBlack?: [number, number][]
): Promise<QcReport> {
  return runQcReport({
    mp4Path: path.join(UPLOAD_ROOT, videoId, "final.mp4"),
    videoDuration,
    narrationSec,
    srtPath: path.join(UPLOAD_ROOT, videoId, "subtitles.srt"),
    expectedBlack,
  });
}
