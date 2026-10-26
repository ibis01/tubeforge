// Bring-your-own-voice — let creators ditch the built-in TTS voices and use
// ANY voice audio they find on the internet (or recorded themselves).
//
//   upload mode : multipart file (mp3 / wav / m4a / ogg / flac / aac / mp4…)
//   url mode    : a direct http(s) link to an audio file, downloaded server-side
//
// The ingest pipeline:
//   1. obtain the raw bytes (upload or download with size + type guards)
//   2. ffprobe-validate it actually contains an audio stream (1s .. 30 min)
//   3. ffmpeg-normalize to the exact studio format TTS produces
//      (24 kHz mono PCM-16 WAV) so every downstream consumer — scene cutter,
//      compositor, ASR verify, captions — works unchanged
//   4. story videos: cut voiceover.wav into per-scene WAVs with the same
//      silence-snapping cutter the classic→scene upgrade uses
//
// Zero TTS calls — the voice the user brought is kept exactly as provided.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { videoDir } from "./ai";
import { cutVoiceoverIntoScenes } from "./convert";
import { parseScenes } from "./story";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

export const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100 MB source cap
export const MAX_AUDIO_SEC = 30 * 60; // 30 minutes
const MIN_AUDIO_SEC = 1;

const execFileAsync = promisify(execFile);

const AUDIO_EXT_RE = /\.(mp3|wav|wave|m4a|aac|ogg|oga|opus|flac|webm|mp4|m4b|wma|aiff?|amr)$/i;

/** Loose "does this look like an audio link" check — final truth is ffprobe. */
export function isValidAudioUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (!u.hostname) return false;
    // No extension is fine (many CDNs serve audio bare) — extension only helps.
    return true;
  } catch {
    return false;
  }
}

/** Best-effort display name from a URL (last path segment, decoded, trimmed). */
export function labelFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    return (seg || u.hostname).slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

interface AudioProbe {
  duration: number;
  hasAudio: boolean;
  codec: string | null;
}

async function probeAudio(filePath: string): Promise<AudioProbe> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name",
      "-show_entries", "format=duration",
      "-of", "json",
      filePath,
    ],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout.toString()) as {
    streams?: { codec_type?: string; codec_name?: string }[];
    format?: { duration?: string };
  };
  const streams = parsed.streams ?? [];
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number(parsed.format?.duration ?? 0);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    hasAudio: Boolean(audio),
    codec: audio?.codec_name ?? null,
  };
}

/** Download an audio file from the internet with sane guards. */
async function downloadAudio(url: string): Promise<{ buffer: Buffer; filename: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000); // 2 min hard cap
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "TubeForge/1.0 (+voice import)" },
    });
    if (!res.ok)
      throw new Error(
        `The site answered ${res.status} ${res.statusText} — check the link works in a browser`
      );

    const lenHeader = Number(res.headers.get("content-length") ?? 0);
    if (lenHeader > MAX_AUDIO_BYTES)
      throw new Error(
        `File is ${(lenHeader / 1024 / 1024).toFixed(0)} MB — the limit is ${MAX_AUDIO_BYTES / 1024 / 1024} MB`
      );

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) throw new Error("The link returned an empty file");
    if (buffer.length > MAX_AUDIO_BYTES)
      throw new Error(
        `Downloaded ${(buffer.length / 1024 / 1024).toFixed(0)} MB — the limit is ${MAX_AUDIO_BYTES / 1024 / 1024} MB`
      );

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const looksAudio =
      contentType.includes("audio") ||
      contentType.includes("octet-stream") ||
      contentType.includes("video/mp4") || // mp4 files often carry the audio track users want
      AUDIO_EXT_RE.test(new URL(url).pathname);

    if (!looksAudio)
      throw new Error(
        `The link serves "${contentType || "unknown type"}" — paste a direct link to an audio file (mp3, wav, m4a…)`
      );

    return { buffer, filename: labelFromUrl(url) };
  } finally {
    clearTimeout(timer);
  }
}

export interface IngestResult {
  durationSec: number;
  fileBytes: number;
  scenesCut: number | null; // null = not a scene video (or no scenes yet)
  sourceLabel: string;
}

/**
 * Ingest user-provided voice audio as the video's voiceover.
 * Throws readable errors — the caller records them on the video row.
 */
export async function ingestCustomAudio(opts: {
  videoId: string;
  source: { kind: "upload"; buffer: Buffer; filename: string } | { kind: "url"; url: string };
  onProgress?: (label: string) => void;
}): Promise<IngestResult> {
  const dir = videoDir(opts.videoId);
  const run = async (args: string[], timeoutMs = 180_000) => {
    try {
      return (
        await execFileAsync("ffmpeg", args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 })
      ).stderr.toString();
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(
        `ffmpeg failed: ${(e.stderr ?? e.message ?? "").split("\n").slice(-4).join("\n").slice(0, 400)}`
      );
    }
  };

  // 1) Obtain the raw bytes.
  let raw: Buffer;
  let sourceLabel: string;
  if (opts.source.kind === "upload") {
    raw = opts.source.buffer;
    sourceLabel = opts.source.filename.slice(0, 80) || "uploaded audio";
    opts.onProgress?.(`Reading ${sourceLabel}`);
  } else {
    if (!isValidAudioUrl(opts.source.url))
      throw new Error("That is not a valid http(s) audio link");
    opts.onProgress?.("Downloading the voice from the internet");
    const dl = await downloadAudio(opts.source.url);
    raw = dl.buffer;
    sourceLabel = dl.filename;
  }

  if (raw.length < 1000) throw new Error("Audio file is too small to be real");
  if (raw.length > MAX_AUDIO_BYTES)
    throw new Error(`Audio exceeds the ${MAX_AUDIO_BYTES / 1024 / 1024} MB limit`);

  // 2) Stage it and validate with ffprobe (extension hints the demuxer).
  const ext = AUDIO_EXT_RE.test(sourceLabel) ? sourceLabel.toLowerCase().match(AUDIO_EXT_RE)![0] : ".bin";
  const staged = path.join(dir, `voice-source${ext}`);
  fs.writeFileSync(staged, raw);

  opts.onProgress?.("Checking the audio");
  let probe: AudioProbe;
  try {
    probe = await probeAudio(staged);
  } catch {
    fs.rmSync(staged, { force: true });
    throw new Error("Could not read that file as audio — is it really an mp3/wav/ogg?");
  }
  if (!probe.hasAudio) {
    fs.rmSync(staged, { force: true });
    throw new Error("That file has no audio track");
  }
  if (probe.duration < MIN_AUDIO_SEC) {
    fs.rmSync(staged, { force: true });
    throw new Error(`Audio is only ${probe.duration.toFixed(1)}s — need at least ${MIN_AUDIO_SEC}s`);
  }
  if (probe.duration > MAX_AUDIO_SEC) {
    fs.rmSync(staged, { force: true });
    throw new Error(
      `Audio is ${Math.round(probe.duration / 60)} min — the limit is ${MAX_AUDIO_SEC / 60} min`
    );
  }

  // 3) Normalize to the studio format every consumer expects (24 kHz mono PCM-16).
  opts.onProgress?.("Converting to studio audio");
  const outPath = path.join(UPLOAD_ROOT, opts.videoId, "voiceover.wav");
  const prevBytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : -1;
  try {
    await run([
      "-y",
      "-i", staged,
      "-vn",            // drop any video stream
      "-ac", "1",       // mono
      "-ar", "24000",   // same rate TTS produces
      "-c:a", "pcm_s16le",
      "-map", "a:0",
      outPath,
    ]);
  } catch (err) {
    // Restore the previous voiceover if a conversion ever half-writes.
    if (prevBytes >= 0 && fs.existsSync(outPath) && fs.statSync(outPath).size === 0)
      fs.rmSync(outPath, { force: true });
    fs.rmSync(staged, { force: true });
    throw err;
  }
  fs.rmSync(staged, { force: true });

  const finalProbe = await probeAudio(outPath);
  if (!finalProbe.hasAudio || finalProbe.duration < MIN_AUDIO_SEC)
    throw new Error("Converted audio came out empty — try a different file");
  const fileBytes = fs.statSync(outPath).size;

  // 4) Scene videos: cut the brought voice into per-scene WAVs so the
  //    compositor / captions / verify consume it exactly like TTS audio.
  let scenesCut: number | null = null;
  const video = await import("@/lib/db").then(({ db }) =>
    db.video.findUnique({ where: { id: opts.videoId } })
  );
  const scenes = video?.format === "story" ? parseScenes(video.scenes) : [];
  if (scenes.length > 0) {
    opts.onProgress?.(`Cutting the voice across ${scenes.length} scenes`);
    const { cut } = await cutVoiceoverIntoScenes({ videoId: opts.videoId, scenes });
    scenesCut = cut;
  }

  return { durationSec: finalProbe.duration, fileBytes, scenesCut, sourceLabel };
}
