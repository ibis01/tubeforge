// Audio-synced captions (Phase 4 — ASR-timed caption sync).
//
// The old SRT showed ONE static caption per scene for the whole scene
// duration. This module replaces it with word-position captioning:
//
//   1. ffmpeg `silencedetect` maps the actual speech runs in every scene WAV
//      (where narration really starts/ends, pause by pause).
//   2. The narration text is split into caption-sized chunks.
//   3. An optional ASR pass transcribes the scene audio so chunk boundaries
//      follow what was actually SPOKEN (TTS sometimes drops or reorders
//      words) — the transcript word stream positions each chunk precisely.
//   4. Chunk positions are mapped onto the speech-run timeline
//      (proportional interpolation inside each run) and offset onto the
//      global video timeline.
//
// Result: captions change exactly when the narration moves — no more one
// frozen line per scene. Falls back gracefully: ASR error → silence-aligned
// narration timing; silencedetect failure → even distribution. Never fails
// a render on its own.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { Scene } from "./types";
import { sceneWavFile } from "./story";
import { transcribe } from "./verify";

const execFileAsync = promisify(execFile);

// Must mirror render.ts so caption times land on the composited timeline.
export const LEAD_SEC = 0.35;

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

export interface SmartCaptionResult {
  srt: string;
  cueCount: number;
  method: "asr" | "silence" | "even"; // which alignment produced the cues
}

// ---------- speech-run detection ----------

export interface SpeechRun {
  start: number; // seconds inside the scene WAV
  end: number;
}

/** Map where speech actually happens in a WAV via ffmpeg silencedetect. */
export async function detectSpeechRuns(
  wavPath: string,
  wavDurationSec: number
): Promise<SpeechRun[]> {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-i", wavPath,
    "-af", "silencedetect=noise=-35dB:d=0.30",
    "-f", "null", "-",
  ]);

  const silences: { start: number; end: number }[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.toString().split("\n")) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (startMatch) {
      pendingStart = Math.max(0, Number(startMatch[1]));
      continue;
    }
    const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (endMatch && pendingStart !== null) {
      const end = Number(endMatch[1]);
      if (end > pendingStart) silences.push({ start: pendingStart, end });
      pendingStart = null;
    }
  }

  // Trailing silence (no silence_end) extends to the file end.
  if (pendingStart !== null && pendingStart < wavDurationSec)
    silences.push({ start: pendingStart, end: wavDurationSec });

  // Complement: speech runs are the gaps between silences.
  const runs: SpeechRun[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start - cursor > 0.15) runs.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (wavDurationSec - cursor > 0.15)
    runs.push({ start: cursor, end: wavDurationSec });

  return runs.filter((r) => r.end - r.start >= 0.25);
}

// ---------- caption chunking ----------

export interface CaptionChunk {
  text: string;
  words: string[];
}

function tokenizeKeepAll(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean);
}

const MAX_CHUNK_WORDS = 9;
const MIN_CHUNK_WORDS = 2;

/** Split narration into short, readable caption chunks at natural breaks. */
export function captionChunks(narration: string): CaptionChunk[] {
  const sentences =
    narration.match(/[^.!?]+[.!?]+["')\]]*\s*/g) ?? [narration];
  const pieces: string[] = [];
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    if (words.length <= MAX_CHUNK_WORDS) {
      pieces.push(words.join(" "));
      continue;
    }
    // Break long sentences at commas (or word gaps when commas are absent).
    let current: string[] = [];
    for (const word of words) {
      current.push(word);
      const atComma = /,$/.test(word);
      if ((atComma && current.length >= 3) || current.length >= MAX_CHUNK_WORDS) {
        pieces.push(current.join(" "));
        current = [];
      }
    }
    if (current.length) {
      if (current.length < MIN_CHUNK_WORDS && pieces.length > 0) {
        pieces[pieces.length - 1] += ` ${current.join(" ")}`;
      } else {
        pieces.push(current.join(" "));
      }
    }
  }
  return pieces
    .map((t) => ({ text: t.trim(), words: tokenizeKeepAll(t) }))
    .filter((c) => c.words.length > 0);
}

// ---------- spoken-word alignment ----------

/**
 * Position each chunk's END inside the spoken word stream using an ASR
 * transcript: a greedy forward cursor matches chunk words to transcript
 * tokens (tolerating small skips for ASR mishears). Returns the transcript
 * token count each chunk ends at.
 */
function chunkEndPositionsByTranscript(
  chunks: CaptionChunk[],
  transcriptTokens: string[]
): number[] {
  let cursor = 0;
  const ends: number[] = [];
  for (const chunk of chunks) {
    for (const word of chunk.words) {
      // Look ahead a little for the next occurrence of this word.
      let found = -1;
      for (let look = 0; look < 10 && cursor + look < transcriptTokens.length; look++) {
        if (transcriptTokens[cursor + look] === word) {
          found = cursor + look;
          break;
        }
      }
      cursor = found >= 0 ? found + 1 : Math.min(cursor + 1, transcriptTokens.length);
    }
    ends.push(cursor);
  }
  // Guarantee monotonic growth (ASR gaps can stall the cursor).
  for (let i = 1; i < ends.length; i++)
    ends[i] = Math.max(ends[i], ends[i - 1] + 1);
  return ends;
}

/** Word positions from the narration itself (fallback when ASR is off/failed). */
function chunkEndPositionsByNarration(chunks: CaptionChunk[]): number[] {
  const ends: number[] = [];
  let count = 0;
  for (const chunk of chunks) {
    count += chunk.words.length;
    ends.push(count);
  }
  return ends;
}

/**
 * Map a spoken-word position (0..totalWords) onto scene-WAV time by spreading
 * the word stream across the detected speech runs proportional to run length.
 */
function wordPosToTime(pos: number, totalWords: number, runs: SpeechRun[]): number {
  if (runs.length === 0) return 0;
  const totalRunSec = runs.reduce((a, r) => a + (r.end - r.start), 0);
  const posFrac = totalWords > 0 ? Math.min(Math.max(pos / totalWords, 0), 1) : 0;
  let target = posFrac * totalRunSec;

  for (const run of runs) {
    const dur = run.end - run.start;
    if (target <= dur) return run.start + target;
    target -= dur;
  }
  return runs[runs.length - 1].end;
}

// ---------- SRT ----------

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

/** Probe a media file's duration in seconds (identical contract to render.ts). */
async function probeDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nk=1:nw=1",
    filePath,
  ]);
  const dur = Number(stdout.trim());
  return Number.isFinite(dur) ? dur : 0;
}

export interface SmartCaptionOpts {
  videoId: string;
  scenes: Scene[];
  segments: { start: number; duration: number }[]; // global render segment map
  asr: boolean; // attempt the ASR alignment pass (silent fallback to narration)
  onProgress?: (label: string) => void;
}

/**
 * Build a word-synced SRT for the whole video. Times land on the composited
 * timeline: segmentStart + LEAD + time-inside-scene-WAV (mirrors the adelay
 * the compositor applies to narration).
 */
export async function buildSmartSrt(
  opts: SmartCaptionOpts
): Promise<SmartCaptionResult> {
  const dir = path.join(UPLOAD_ROOT, opts.videoId);
  const cues: { start: number; end: number; text: string }[] = [];
  let method: SmartCaptionResult["method"] = "silence";

  for (const [i, scene] of opts.scenes.entries()) {
    const wavPath = path.join(dir, sceneWavFile(scene.index));
    const segment = opts.segments[i];
    if (!segment || !fs.existsSync(wavPath)) continue;

    const chunks = captionChunks(scene.narration);
    if (chunks.length === 0) continue;

    const wavDur = await probeDurationSec(wavPath);
    const runs = wavDur > 0 ? await detectSpeechRuns(wavPath, wavDur) : [];

    if (runs.length === 0) {
      // No silence structure detected — spread evenly across the narration.
      method = "even";
      const speechStart = LEAD_SEC;
      const speechEnd = Math.max(LEAD_SEC + wavDur, segment.duration - 0.2);
      const span = Math.max(speechEnd - speechStart, 1);
      chunks.forEach((chunk, ci) => {
        const start = speechStart + (span * ci) / chunks.length;
        const end = speechStart + (span * (ci + 1)) / chunks.length;
        cues.push({
          start: segment.start + start,
          end: segment.start + end,
          text: chunk.text,
        });
      });
      continue;
    }

    let ends: number[];
    let totalWords: number;

    if (opts.asr) {
      try {
        opts.onProgress?.(`Syncing captions for scene ${scene.index} (ASR)`);
        const transcript = await transcribe(wavPath);
        const transcriptTokens = tokenizeKeepAll(transcript);
        if (transcriptTokens.length >= chunks[0].words.length) {
          ends = chunkEndPositionsByTranscript(chunks, transcriptTokens);
          totalWords = Math.max(transcriptTokens.length, ends[ends.length - 1]);
          if (ends[ends.length - 1] > 0) method = "asr";
        } else {
          ends = chunkEndPositionsByNarration(chunks);
          totalWords = ends[ends.length - 1];
        }
      } catch {
        // ASR unavailable — silence-aligned narration timing still applies.
        ends = chunkEndPositionsByNarration(chunks);
        totalWords = ends[ends.length - 1];
      }
    } else {
      ends = chunkEndPositionsByNarration(chunks);
      totalWords = ends[ends.length - 1];
    }

    // Back-translate chunk word positions into scene-WAV times.
    // Chunk i spans spoken positions (ends[i-1], ends[i]] — same monotonic
    // mapping as the end positions, so consecutive cues naturally abut.
    const startPos = ends.map((_, i) => (i === 0 ? 0 : ends[i - 1]));

    chunks.forEach((chunk, ci) => {
      const wavStart = wordPosToTime(startPos[ci], totalWords, runs);
      const wavEnd = wordPosToTime(ends[ci], totalWords, runs);

      const globalStart = segment.start + LEAD_SEC + wavStart;
      const rawEnd = segment.start + LEAD_SEC + Math.max(wavEnd, wavStart + 0.4);

      cues.push({
        start: globalStart,
        end: Math.min(rawEnd, segment.start + segment.duration),
        text: chunk.text,
      });
    });
  }

  const srt = cues
    .map((cue, i) => {
      const nextStart = i + 1 < cues.length ? cues[i + 1].start : null;
      let end = cue.end;
      // Leave a 50ms gap before the next cue so text visibly refreshes,
      // but never below the minimum readable duration.
      if (nextStart !== null && nextStart - 0.05 < end && cue.start + 0.3 < nextStart - 0.05)
        end = nextStart - 0.05;
      return `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(Math.max(end, cue.start + 0.4))}\n${cue.text}\n`;
    })
    .join("\n");

  return { srt, cueCount: cues.length, method };
}
