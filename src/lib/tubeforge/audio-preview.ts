// Mix preview — "hear the mix before rendering the whole video".
//
// Renders a short window (default 12 s, max 20 s) of the FINAL sound: the
// real per-scene narration WAVs on the render timeline (same lead-in/tail
// pacing as render.ts), the resolved library track (or synthesized drone
// fallback), the SAME ducking chain, and the SAME measure-then-normalize
// contract (-16 LUFS / -1 dBTP) from audiomix.ts. What you hear is what the
// render will ship, minus the video encode.
//
// Cost: three short ffmpeg passes on ≤20 s of audio (well under a second
// each), so the route can serve previews on demand.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { MusicTrack, Video } from "@prisma/client";
import { parseScenes, sceneWavFile } from "./story";
import { videoDir } from "./ai";
import {
  resolveMusicForVideo,
  resolveDuckingForVideo,
  isMusicEnabledForVideo,
  trackAbsolutePath,
} from "./music";
import {
  duckChain,
  mixTail,
  measureLoudness,
  normalizationFilter,
  type DuckIntensity,
} from "./audiomix";
import { droneSource, musicProfileForNiche, LEAD_SEC, TAIL_SEC, MIN_SEG_SEC } from "./render";

const execFileAsync = promisify(execFile);

export const PREVIEW_MIN_SEC = 3;
export const PREVIEW_MAX_SEC = 20;
export const PREVIEW_DEFAULT_SEC = 12;

export interface AudioPreview {
  buffer: Buffer;
  contentType: "audio/mpeg";
  startSec: number;
  durationSec: number;
  /** What the music engine picked, for the UI toast/label. */
  musicWhy: string | null;
  duckIntensity: DuckIntensity;
}

async function runFfmpeg(args: string[], timeoutMs = 60_000): Promise<void> {
  try {
    await execFileAsync("ffmpeg", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const tail = (e.stderr ?? e.message ?? "").replace(/\r/g, "\n").split("\n").filter(Boolean).slice(-4).join(" | ");
    throw new Error(`Mix preview failed: ${tail.slice(0, 300)}`);
  }
}

/**
 * Build one preview window. `startSec` is clamped into the narration
 * timeline; throws with actionable messages when the voiceover is missing.
 */
export async function buildAudioPreview(
  video: Video,
  opts: { startSec?: number; durationSec?: number } = {}
): Promise<AudioPreview> {
  const scenes = parseScenes(video.scenes);
  const dir = videoDir(video.id);
  const wavs = scenes.map((s) => path.join(dir, sceneWavFile(s.index)));
  if (scenes.length === 0)
    throw new Error("No scenes yet — generate the scene script first");
  if (!fs.existsSync(wavs[0]))
    throw new Error("No scene voiceover yet — generate the voiceover first");

  // Scene timings on the CUT timeline (same pacing as render.ts; blends pull
  // cues sub-second earlier, immaterial for a listen check).
  const durations: number[] = [];
  for (const w of wavs) {
    if (!fs.existsSync(w)) break; // trailing missing scenes stop the preview
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", w],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const d = Number((JSON.parse(stdout.toString()) as { format?: { duration?: string } }).format?.duration ?? 0);
    durations.push(Math.max(d + LEAD_SEC + TAIL_SEC, MIN_SEG_SEC));
  }
  if (durations.length === 0) throw new Error("No readable scene voiceover files");

  const total = durations.reduce((a, b) => a + b, 0);
  const wantDur = Math.min(Math.max(opts.durationSec ?? PREVIEW_DEFAULT_SEC, PREVIEW_MIN_SEC), PREVIEW_MAX_SEC);
  const start = Math.min(Math.max(opts.startSec ?? 0, 0), Math.max(total - PREVIEW_MIN_SEC, 0));
  const duration = Math.min(wantDur, Math.max(total - start, PREVIEW_MIN_SEC));
  const end = Math.min(start + duration, total);

  // Music resolution — exactly what the render route would pick. Three
  // states, mirroring the finalizer: DISABLED (voice only), enabled + track
  // (ducked library bed), enabled + no match (ducked synthesized drone).
  const musicEnabled = await isMusicEnabledForVideo(video);
  const resolved = musicEnabled ? await resolveMusicForVideo(video) : null;
  const duck: DuckIntensity = resolved
    ? resolved.duckIntensity
    : await resolveDuckingForVideo(video);
  const track: MusicTrack | null = resolved?.track ?? null;
  const trackFile = track ? trackAbsolutePath(track) : null;
  const useTrack = track && trackFile && fs.existsSync(trackFile) ? trackFile : null;

  const tmpDir = path.join(dir, "preview-audio-tmp");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const mixWav = path.join(tmpDir, "mix.wav");
  const outMp3 = path.join(tmpDir, "preview.mp3");

  try {
    // ---- Pass 1: the windowed mix (voice [+ ducked bed]) → WAV ----
    const args: string[] = [];
    for (const w of wavs.slice(0, durations.length)) args.push("-i", w);
    if (musicEnabled) {
      if (useTrack) {
        args.push("-stream_loop", "-1", "-i", useTrack);
      } else {
        args.push("-f", "lavfi", "-t", total.toFixed(3), "-i", droneSource(musicProfileForNiche(video.niche)));
      }
    }

    const filters: string[] = [];
    const n = durations.length;
    // Voice: each scene WAV lands at its segment start + lead-in, non
    // overlapping, so a straight sum == the concatenated narration timeline.
    for (let i = 0; i < n; i++) {
      const segStart = durations.slice(0, i).reduce((a, b) => a + b, 0);
      const delayMs = Math.round((segStart + LEAD_SEC) * 1000);
      filters.push(`[${i}:a]aformat=channel_layouts=stereo,adelay=${delayMs}:all=1[vc${i}]`);
    }
    const voiceLabels = Array.from({ length: n }, (_, i) => `[vc${i}]`).join("");
    filters.push(
      `${voiceLabels}amix=inputs=${n}:duration=longest:normalize=0[vfull]`,
      `[vfull]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=N/SR/TB[vt]`
    );

    const winSec = end - start;
    if (!musicEnabled) {
      // Music off for this video — the preview is the normalized narration.
      filters.push(`[vt]anull[mix]`);
    } else {
      filters.push(`[vt]asplit=2[voice][sc]`);
      if (useTrack && resolved) {
        // Slice the library track at the SAME absolute window, apply the gain
        // the render would use, and micro-fade the window edges so the excerpt
        // never clicks (the full render uses the track's real fade lengths).
        filters.push(
          `[${n}:a]aformat=channel_layouts=stereo,atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=N/SR/TB,` +
            `volume=${resolved.gain.toFixed(3)},afade=t=in:d=0.15,` +
            `afade=t=out:st=${Math.max(winSec - 0.4, 0).toFixed(2)}:d=0.4[music]`,
          duckChain(duck),
          mixTail(1, 1)
        );
      } else {
        // Synthesized drone fallback at the render's bed weight.
        filters.push(
          `[${n}:a]aformat=channel_layouts=stereo,atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=N/SR/TB,` +
            `afade=t=in:d=0.15,afade=t=out:st=${Math.max(winSec - 0.4, 0).toFixed(2)}:d=0.4[music]`,
          duckChain(duck),
          mixTail(1, 0.85)
        );
      }
    }

    await runFfmpeg([
      ...args,
      "-filter_complex", filters.join(";"),
      "-map", "[mix]",
      "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
      "-y", mixWav,
    ]);

    // ---- Pass 2+3: measure → normalize → MP3 (the delivery contract) ----
    const measured = await measureLoudness(mixWav);
    await runFfmpeg([
      "-i", mixWav,
      "-af", normalizationFilter(measured),
      "-c:a", "libmp3lame", "-b:a", "192k",
      "-y", outMp3,
    ]);

    return {
      buffer: fs.readFileSync(outMp3),
      contentType: "audio/mpeg",
      startSec: Math.round(start * 10) / 10,
      durationSec: Math.round(winSec * 10) / 10,
      musicWhy: !musicEnabled
        ? null
        : resolved
          ? resolved.why
          : "synthesized bed (drone fallback)",
      duckIntensity: musicEnabled ? duck : "off",
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
