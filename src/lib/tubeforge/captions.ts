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
import { transcribe, transcribeWords } from "./verify";

const execFileAsync = promisify(execFile);

// Must mirror render.ts so caption times land on the composited timeline.
export const LEAD_SEC = 0.35;

import { scratchDir } from "./storage";

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

/** The captions lane's word tokenizer (kept-all form: hyphens survive). The
 *  ASR transcript stream and the chunk word stream are tokenized here —
 *  the greedy cursor compares like with like. W4: exported for the
 *  whiteboard lane's voice-anchor ladder (one tokenizer, two consumers). */
export function tokenizeKeepAll(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean);
}

const MAX_CHUNK_WORDS = 7;
const MIN_CHUNK_WORDS = 2;

/**
 * Protect number tokens from sentence splitting BEFORE the regex runs:
 * "$6.5 million", "3.14", "12,440" must never be cut at their decimal point
 * (the old splitter produced caption cues like "$6." / "5 million each.").
 * Decimal points are swapped to a placeholder and restored after splitting.
 */
function protectNumbers(text: string): { guarded: string; restore: (s: string) => string } {
  const DOT = "\u0001";
  const guarded = text.replace(/(\d)\.(\d)/g, "$1" + DOT + "$2");
  return { guarded, restore: (s) => s.replace(new RegExp(DOT, "g"), ".") };
}

/** Split narration into short, readable caption chunks at natural breaks. */
export function captionChunks(narration: string): CaptionChunk[] {
  const { guarded, restore } = protectNumbers(narration);
  const sentences = guarded.match(/[^.!?]+[.!?]+["')\]]*\s*/g) ?? [guarded];
  const pieces: string[] = [];
  for (const sentence of sentences) {
    const restored = restore(sentence);
    const words = restored.trim().split(/\s+/).filter(Boolean);
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
 *
 * W4: exported for the whiteboard lane's voice anchors — the SAME greedy
 * cursor positions the whiteboard's spoken-window schedule (one alignment,
 * two consumers).
 */
export function chunkEndPositionsByTranscript(
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

/** Word positions from the narration itself (fallback when ASR is off/failed).
 *  W4: exported for the whiteboard lane's voice anchors. */
export function chunkEndPositionsByNarration(chunks: CaptionChunk[]): number[] {
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
 * W4: exported for the whiteboard lane's voice anchors.
 */
export function wordPosToTime(pos: number, totalWords: number, runs: SpeechRun[]): number {
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

/**
 * Snap a proportional word-position timestamp to the nearest real speech-run
 * boundary when one sits within ±0.45s. Proportional mapping assumes a
 * uniform speaking rate, which drifts around pauses — but a pause IS a
 * phrase boundary, so cue starts that land near one should sit exactly on
 * it. This measurably tightens perceived subtitle↔voice sync.
 * W4: exported for the whiteboard lane's voice anchors.
 */
export function snapToPause(t: number, runs: SpeechRun[], maxShift = 0.45): number {
  let best = t;
  let bestD = maxShift;
  for (const r of runs) {
    for (const boundary of [r.start, r.end]) {
      const d = Math.abs(t - boundary);
      if (d < bestD) {
        best = boundary;
        bestD = d;
      }
    }
  }
  return best;
}

/**
 * The chunk windows in scene-WAV time — the ONE chunk↔clock mapping both
 * caption cues (buildSmartSrt) and the whiteboard's per-word voice anchors
 * (whiteboard/voice-anchors.ts) read. Chunk i spans spoken positions
 * (ends[i-1], ends[i]]; each window starts snapped to a real pause when one
 * is close and never runs shorter than 0.4s. Pure — unit-pinned.
 */
export function wavChunkWindows(
  ends: number[],
  totalWords: number,
  runs: SpeechRun[]
): { startSec: number; endSec: number }[] {
  const startPos = ends.map((_, i) => (i === 0 ? 0 : ends[i - 1]));
  return ends.map((end, i) => {
    const startSec = snapToPause(wordPosToTime(startPos[i], totalWords, runs), runs);
    const endSec = Math.max(wordPosToTime(end, totalWords, runs), startSec + 0.4);
    return { startSec, endSec };
  });
}

// ---------- S121 — the measured rung's chunk windows ----------

/** An ASR word timestamp (absolute seconds inside the scene WAV). */
export interface AsrWordSpan {
  word: string;
  start: number;
  end: number;
}

/**
 * S121 RUNG 1 — the MEASURED chunk windows: instead of spreading the word
 * stream proportionally across the speech runs, each chunk's window is the
 * measured span of the words the transcript cursor assigned to it. The laws
 * of wavChunkWindows carry over unchanged (unit-pinned):
 *   • a window never runs shorter than 0.4 s (extended, never shrunk — the
 *     measured truth is the floor, not a target);
 *   • windows NEVER overlap (a cursor drift clamps the start forward);
 *   • the output is monotone.
 * Null when the word stream cannot hold the chunks (drift lost a whole
 * chunk's words) — the caller degrades to the proportional rung, byte-identical.
 * Pure — unit-pinned.
 */
export function chunkWindowsFromWordTimes(
  words: AsrWordSpan[],
  ends: number[]
): { startSec: number; endSec: number }[] | null {
  if (words.length === 0 || ends.length === 0) return null;
  const windows: { startSec: number; endSec: number }[] = [];
  let prevEnd = -1;
  for (let i = 0; i < ends.length; i++) {
    const startIdx = Math.min(i === 0 ? 0 : ends[i - 1], words.length - 1);
    const endIdx = Math.min(ends[i] - 1, words.length - 1);
    if (endIdx < startIdx) return null; // the cursor lost this chunk's words
    const first = words[startIdx];
    const last = words[endIdx];
    if (!first || !last) return null;
    let startSec = Math.min(first.start, last.end);
    const endSec = Math.max(last.end, startSec + 0.4); // the 0.4 s floor
    if (i > 0 && startSec < prevEnd) startSec = prevEnd; // the non-overlap law
    windows.push({ startSec, endSec });
    prevEnd = endSec;
  }
  return windows;
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
  /** S2 — per-scene caption text edited in the Timeline Studio (aligned by
   *  position, null = no edit). An edited scene renders ONE cue spanning its
   *  window with the edited text instead of its ASR/narration chunks — the
   *  user's edit is the contract, chunking is only for unedited scenes. */
  captionOverrides?: (string | null)[] | null;
}

/** S43 — the caption override chain, one source of truth for BOTH caption
 *  paths (smart/ASR + one-per-scene fallback):
 *
 *    doc caption (Timeline Studio edit)
 *      > row caption WITH captionUser (Scene Studio edit — PATCH sets the flag)
 *      > null (word-synced narration chunks)
 *
 *  The script LLM seeds `caption` on EVERY scene, so a non-empty row caption
 *  alone must never override the chunks — that regressed Phase 4's word-sync
 *  into one frozen line per scene. Only HUMAN edits are the contract.
 *  Pure — unit-pinned. */
export function captionOverridesFor(
  scenes: { caption: string; captionUser?: boolean }[],
  docCaptions: (string | null)[] | null
): (string | null)[] {
  return scenes.map((s, i) => {
    const doc = docCaptions?.[i] ?? null;
    if (typeof doc === "string" && doc.trim()) return doc;
    return s.captionUser && s.caption.trim() ? s.caption : null;
  });
}

/**
 * Build a word-synced SRT for the whole video. Times land on the composited
 * timeline: segmentStart + LEAD + time-inside-scene-WAV (mirrors the adelay
 * the compositor applies to narration).
 */
/** A caption cue in video time (seconds). */
export interface SrtCue {
  start: number;
  end: number;
  text: string;
}

/** Render cues as an SRT with a HARD non-overlap pass (Battle Yamuk shipped
 *  54 overlapping cues): the earlier cue ALWAYS yields — trimmed to the next
 *  cue's start minus a 50 ms refresh gap. A too-short cue is a cosmetic nit;
 *  an overlapping cue fails the QC captions check. Cues are sorted by start
 *  first so blended-timeline shifts (which pull later scenes' starts earlier)
 *  can't disorder the stream. Pure — unit-pinned. */
export function formatSrtCues(input: SrtCue[]): string {
  const cues = [...input].sort((a, b) => a.start - b.start);
  return cues
    .map((cue, i) => {
      const nextStart = i + 1 < cues.length ? cues[i + 1].start : null;
      let end = cue.end;
      if (nextStart !== null && end > nextStart - 0.05) {
        end = Math.max(nextStart - 0.05, cue.start + 0.15);
      }
      return `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(Math.max(end, cue.start + 0.15))}\n${cue.text}\n`;
    })
    .join("\n");
}

export async function buildSmartSrt(
  opts: SmartCaptionOpts
): Promise<SmartCaptionResult> {
  const dir = scratchDir(opts.videoId); // storage seam (T-3.7)
  const cues: { start: number; end: number; text: string }[] = [];
  let method: SmartCaptionResult["method"] = "silence";

  for (const [i, scene] of opts.scenes.entries()) {
    const wavPath = path.join(dir, sceneWavFile(scene.index));
    const segment = opts.segments[i];
    if (!segment) continue;

    // S2 — a studio-edited caption replaces this scene's cues whole: one
    // cue across the scene's blended window, the edited text verbatim.
    const override = opts.captionOverrides?.[i];
    if (typeof override === "string" && override.trim()) {
      cues.push({
        start: segment.start + 0.02,
        end: segment.start + segment.duration,
        text: override.trim(),
      });
      continue;
    }

    if (!fs.existsSync(wavPath)) continue;

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
        // S121 RUNG 1 — the MEASURED pass first: word timestamps decide where
        // chunks sit (the whisperx ±10-30 ms class). Anything that refuses —
        // a provider without word support (typed signal), a server hiccup,
        // a word stream that can't hold the chunks — degrades to RUNG 2
        // below, byte-identical: the ladder never fails a render.
        let measured: { text: string; words: AsrWordSpan[] } | null = null;
        try {
          const detailed = await transcribeWords(wavPath);
          if (detailed.words.length > 0) measured = detailed;
        } catch {
          measured = null; // typed unsupported / transient error → rung 2
        }

        if (measured) {
          const tokens = measured.words.map(
            (w) => tokenizeKeepAll(w.word)[0] ?? w.word.trim().toLowerCase()
          );
          const measuredEnds = chunkEndPositionsByTranscript(chunks, tokens);
          const measuredWindows = chunkWindowsFromWordTimes(measured.words, measuredEnds);
          if (measuredWindows) {
            const windows = measuredWindows;
            chunks.forEach((chunk, ci) => {
              const { startSec: wavStart, endSec: rawWavEnd } = windows[ci];
              const globalStart = Math.max(
                segment.start + 0.02,
                segment.start + LEAD_SEC + wavStart - 0.08
              );
              const rawEnd = segment.start + LEAD_SEC + Math.max(rawWavEnd, wavStart + 0.4);
              cues.push({
                start: globalStart,
                end: Math.min(rawEnd, segment.start + segment.duration),
                text: chunk.text,
              });
            });
            method = "asr";
            continue;
          }
          // windows null → fall through to the proportional rung below.
        }

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

    // Back-translate chunk word positions into scene-WAV times — through the
    // SHARED wavChunkWindows mapping (the whiteboard's voice anchors read the
    // same windows; one chunk↔clock law, two consumers).
    const windows = wavChunkWindows(ends, totalWords, runs);

    chunks.forEach((chunk, ci) => {
      const { startSec: wavStart, endSec: rawWavEnd } = windows[ci];
      const wavEnd = rawWavEnd;

      // Cues lead the voice by 80 ms (captions that appear a beat early read
      // as in-sync; captions that lag read as broken). Never slip back past
      // the scene start though.
      const globalStart = Math.max(
        segment.start + 0.02,
        segment.start + LEAD_SEC + wavStart - 0.08
      );
      const rawEnd = segment.start + LEAD_SEC + Math.max(wavEnd, wavStart + 0.4);

      cues.push({
        start: globalStart,
        end: Math.min(rawEnd, segment.start + segment.duration),
        text: chunk.text,
      });
    });
  }

  return { srt: formatSrtCues(cues), cueCount: cues.length, method };
}
