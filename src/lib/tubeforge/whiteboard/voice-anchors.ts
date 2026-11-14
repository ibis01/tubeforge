// W4 slice 3 — the captions lane's alignment becomes the whiteboard's
// spoken-window schedule (S120 §3 W4; the roadmap row: "the whiteboard
// render job passes captions-lane anchors").
//
// The captions lane already knows where speech happens (detectSpeechRuns —
// ffmpeg silencedetect −35 dB / 0.30 s) and where each narration chunk lands
// inside it (the greedy transcript cursor, or word-count fallback — the
// buildSmartSrt machinery). This module is the BRIDGE: the same chunk
// windows, refined to PER-WORD spans, in the WordAnchors contract the beat
// plan (slice 1) consumes. One alignment, two consumers — the captions cues
// and the whiteboard's strokes land on the same spoken clock (the one-source
// law), never a forked second implementation.
//
// The degradation ladder is the captions lane's own, restated: ASR answers →
// chunk boundaries follow what was actually SPOKEN; the ASR pass fails or is
// disabled → silence-run-refined narration timing; no VO or no speech
// structure → null and the caller keeps the word-proportional estimator
// BYTE-FOR-BYTE (the slice-1 hard pin). The ladder never fails a render.

import type { SpeechRun } from "../captions";
import {
  captionChunks,
  chunkEndPositionsByNarration,
  chunkEndPositionsByTranscript,
  detectSpeechRuns,
  measuredAlignment,
  tokenizeKeepAll,
  wavChunkWindows,
} from "../captions";
import { transcribe, transcribeWords } from "../verify";
import { anchorEnvelope, type WordAnchors } from "./timing";
import { words } from "./beat-plan";

// ---------------------------------------------------------------------------
// The pure core.
// ---------------------------------------------------------------------------

export interface BuildVoiceAnchorsInput {
  narration: string;
  /** The captions lane's chunks over the narration (captionChunks). */
  chunks: { text: string }[];
  /** Each chunk's END in the spoken-word stream (transcript or narration
   *  cursor — the captions lane's own outputs). */
  ends: number[];
  /** The spoken stream's total token count (transcript tokens, or the
   *  narration fallback's word count). */
  totalWords: number;
  /** The scene WAV's speech runs (seconds). */
  runs: SpeechRun[];
  /** The scene's clock (ms) — spans are clamped inside it. */
  sceneDurationMs: number;
  /** S121 RUNG 1 — the MEASURED chunk windows (seconds, absolute in the
   *  scene WAV) from the detailed ASR pass. Absent/null → the proportional
   *  baseline below runs BYTE-IDENTICAL (the slice-1 hard pin). */
  measuredWindows?: { startSec: number; endSec: number }[] | null;
  /** S121 RUNG 1 — per-chunk per-beat-word measured spans (ms), either
   *  mapped 1:1 onto each chunk's beat words (when the chunk's measured
   *  word count matches) or exactly counts[i] entries. Absent → the
   *  chunk's measured window spreads across its beat words. */
  measuredWordSpansMs?: { startMs: number; endMs: number }[][] | null;
}

/**
 * buildVoiceAnchors — the captions lane's chunk windows, refined to per-word
 * spans. PURE: fixed arithmetic, no fs, no clock; the same inputs are
 * byte-identical on every call.
 *
 *   chunk i's window  = wavChunkWindows(ends, totalWords, runs)[i]
 *                       (the EXACT mapping buildSmartSrt's cues ride);
 *   word k of chunk i = an even slice of that window across the chunk's
 *                       beat-tokenized words (the beat plan's own tokenizer —
 *                       one index space with the sentence windows).
 *
 * Returns null (→ the caller keeps the estimator) when anything is absent or
 * degenerate: no chunks, no speech runs, non-monotonic ends, a zero word
 * stream, or any span the scene clock cannot hold. A misheard ASR pass thus
 * degrades — it never corrupts the choreography.
 */
export function buildVoiceAnchors(input: BuildVoiceAnchorsInput): WordAnchors | null {
  const {
    narration,
    chunks,
    ends,
    totalWords,
    runs,
    sceneDurationMs,
    measuredWindows,
    measuredWordSpansMs,
  } = input;
  if (!narration || narration.trim() === "") return null;
  if (chunks.length === 0 || ends.length !== chunks.length) return null;
  if (!(totalWords > 0) || runs.length === 0) return null;
  if (!(sceneDurationMs > 0)) return null;
  // The ends must march forward (the captions lane guarantees monotonic
  // growth; the pure core refuses anything else rather than guess).
  for (let i = 0; i < ends.length; i++) {
    if (!Number.isFinite(ends[i]) || ends[i] <= 0) return null;
    if (i > 0 && ends[i] < ends[i - 1]) return null;
  }
  // The per-chunk beat-token counts — the anchor index space. The chunks
  // partition the narration's text, so the counts sum to the narration's
  // beat tokenization (the count contract beatSceneEvents enforces); any
  // violation is a caller bug and degrades honestly.
  const counts = chunks.map((c) => words(c.text ?? "").length);
  const flat = counts.reduce((a, b) => a + b, 0);
  if (flat === 0) return null;

  const windows = wavChunkWindows(ends, totalWords, runs);
  if (windows.length !== chunks.length) return null;

  const byWord: WordAnchors["byWord"] = [];
  let index = 0;
  for (let i = 0; i < chunks.length; i++) {
    const count = counts[i];
    if (count === 0) {
      // A chunk whose text carries no beat tokens (pure punctuation) —
      // it still owned a window; skip its span, keep the stream contiguous.
      continue;
    }
    // S121 RUNG 1 — the MEASURED spans win when present: per-beat-word spans
    // mapped 1:1 (exactly counts[i] entries) or the chunk's measured window
    // spread across its beat words. The scene clock still clamps (and a
    // clock that cannot hold a span degrades to null — the measured truth
    // never overruns the render).
    const spans = measuredWordSpansMs?.[i];
    const measuredWindow = measuredWindows?.[i];
    if (spans && spans.length === count) {
      for (let k = 0; k < count; k++) {
        const wStart = Math.min(Math.max(0, Math.round(spans[k].startMs)), sceneDurationMs - 1);
        const wEnd = Math.min(Math.max(0, Math.round(spans[k].endMs)), sceneDurationMs - 1);
        if (!(wEnd > wStart)) return null;
        byWord.push({ index, startMs: wStart, endMs: wEnd });
        index += 1;
      }
      continue;
    }
    if (measuredWindow && measuredWindow.endSec > measuredWindow.startSec) {
      const startMs = measuredWindow.startSec * 1000;
      const durMs = (measuredWindow.endSec - measuredWindow.startSec) * 1000;
      for (let k = 0; k < count; k++) {
        const wStart = Math.min(Math.round(startMs + (durMs * k) / count), sceneDurationMs - 1);
        const wEnd = Math.min(Math.round(startMs + (durMs * (k + 1)) / count), sceneDurationMs - 1);
        if (!(wEnd > wStart)) return null;
        byWord.push({ index, startMs: wStart, endMs: wEnd });
        index += 1;
      }
      continue;
    }
    // The proportional baseline (rung 2) — BYTE-IDENTICAL when the measured
    // rung is absent.
    const startSec = windows[i].startSec;
    const endSec = windows[i].endSec;
    if (!(endSec > startSec)) return null;
    const startMs = startSec * 1000;
    const durMs = (endSec - startSec) * 1000;
    for (let k = 0; k < count; k++) {
      const wStart = Math.min(Math.round(startMs + (durMs * k) / count), sceneDurationMs - 1);
      const wEnd = Math.min(Math.round(startMs + (durMs * (k + 1)) / count), sceneDurationMs - 1);
      if (!(wEnd > wStart)) return null; // the clock cannot hold this span
      byWord.push({ index, startMs: wStart, endMs: wEnd });
      index += 1;
    }
  }
  if (byWord.length !== flat) return null; // every narration word carries a span
  // The envelope must fit the scene clock (the beat plan's own guard —
  // checked here so the caller sees the same verdict the engine would).
  const env = anchorEnvelope({ byWord }, sceneDurationMs);
  if (!env) return null;
  return { byWord };
}

// ---------------------------------------------------------------------------
// The async ladder (the captions lane's shape: try the ASR pass, degrade
// gracefully, never fail the render).
// ---------------------------------------------------------------------------

export interface SceneVoiceAnchorsArgs {
  narration: string;
  /** The scene's VO WAV (scratch path — the loudness-contract slot). */
  voPath: string;
  /** The VO's measured duration (seconds — the pre-flight probe). */
  voDurationSec: number;
  /** The scene's clock (ms). */
  sceneDurationMs: number;
  /** Attempt the ASR pass (the smart-captions opt-in). */
  asr: boolean;
}

/**
 * sceneVoiceAnchors — detectSpeechRuns + the captions lane's chunk alignment
 * → per-word anchors for one scene WAV. Null means "keep the estimator" —
 * no VO, no speech structure, or a degenerate alignment. Throws nothing by
 * contract: every failure inside degrades to the narration fallback or null.
 */
export async function sceneVoiceAnchors(args: SceneVoiceAnchorsArgs): Promise<WordAnchors | null> {
  const narration = (args.narration ?? "").trim();
  if (!narration) return null;
  if (!(args.voDurationSec > 0)) return null;
  let runs: SpeechRun[] = [];
  try {
    runs = await detectSpeechRuns(args.voPath, args.voDurationSec);
  } catch {
    return null; // no speech structure → the estimator keeps the clock
  }
  if (runs.length === 0) return null;
  const chunks = captionChunks(narration);
  if (chunks.length === 0) return null;

  // S121 RUNG 1 — the MEASURED ladder: the detailed ASR pass answers with
  // per-word timestamps and the ONE measured alignment (measuredAlignment —
  // the caption cues' own computation, the one-alignment law) places every
  // chunk. Each chunk's beat words ride its measured words 1:1 (equal
  // counts) or proportionally inside the measured window. Anything that
  // refuses — a provider without word support (the typed signal), a server
  // hiccup, a word stream that cannot hold the chunks — falls through to the
  // historical ladder below, BYTE-IDENTICAL: the rung upgrades, it never
  // breaks.
  if (args.asr) {
    try {
      const detailed = await transcribeWords(args.voPath);
      if (detailed.words.length > 0) {
        const aligned = measuredAlignment(chunks, detailed.words);
        if (aligned) {
          // Per-chunk per-beat-word spans: 1:1 when the chunk's measured
          // word count matches its beat count, else proportional inside
          // the chunk's measured window.
          const spans: { startMs: number; endMs: number }[][] = [];
          for (let i = 0; i < chunks.length; i++) {
            const beatCount = words(chunks[i].text ?? "").length;
            const startIdx = Math.min(i === 0 ? 0 : aligned.ends[i - 1], detailed.words.length - 1);
            const endIdx = Math.min(aligned.ends[i] - 1, detailed.words.length - 1);
            const chunkWords = beatCount > 0 && endIdx >= startIdx
              ? detailed.words.slice(startIdx, endIdx + 1)
              : [];
            if (chunkWords.length === beatCount) {
              spans.push(
                chunkWords.map((w) => ({
                  startMs: w.start * 1000,
                  endMs: w.end * 1000,
                }))
              );
            } else {
              spans.push([]); // no 1:1 — the window path spreads instead
            }
          }
          return buildVoiceAnchors({
            narration,
            chunks,
            ends: aligned.ends,
            totalWords: Math.max(aligned.tokens.length, aligned.ends[aligned.ends.length - 1]),
            runs,
            sceneDurationMs: args.sceneDurationMs,
            measuredWindows: aligned.windows,
            measuredWordSpansMs: spans,
          });
        }
      }
    } catch {
      // The typed unsupported signal / transient error → the historical rung.
    }
  }

  // The captions lane's own ladder (buildSmartSrt, verbatim shape):
  // transcript cursor when the ASR pass answers with enough tokens, the
  // narration word-count cursor otherwise.
  let ends: number[];
  let totalWords: number;
  if (args.asr) {
    try {
      const transcript = await transcribe(args.voPath);
      const transcriptTokens = tokenizeKeepAll(transcript);
      if (transcriptTokens.length >= chunks[0].words.length) {
        ends = chunkEndPositionsByTranscript(chunks, transcriptTokens);
        totalWords = Math.max(transcriptTokens.length, ends[ends.length - 1]);
      } else {
        ends = chunkEndPositionsByNarration(chunks);
        totalWords = ends[ends.length - 1];
      }
    } catch {
      ends = chunkEndPositionsByNarration(chunks);
      totalWords = ends[ends.length - 1];
    }
  } else {
    ends = chunkEndPositionsByNarration(chunks);
    totalWords = ends[ends.length - 1];
  }

  return buildVoiceAnchors({ narration, chunks, ends, totalWords, runs, sceneDurationMs: args.sceneDurationMs });
}
