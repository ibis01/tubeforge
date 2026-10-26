// ASR narration proofreading (Phase 3 — robustness).
//
// Transcribes the generated voiceover back to text with ASR and compares it
// against the written script, producing a similarity report. This catches
// TTS glitches (truncated chunks, mispronounced runs, silent endings) BEFORE
// a broken narration gets rendered into a video and uploaded.
//
// Story videos are checked per scene (scene-XX.wav), so the report pinpoints
// WHICH scene drifted. Large files are transcoded to compact MP3 with ffmpeg
// before being sent to ASR.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { db } from "@/lib/db";
import { getZAI } from "./ai";
import { aiCall } from "./budget";
import { parseScenes } from "./story";

const execFileAsync = promisify(execFile);
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

export interface VerifyReport {
  ranAt: string;
  format: "script" | "story";
  similarity: number; // 0..1 — share of script words found in the transcript
  scriptWords: number;
  transcriptWords: number;
  verdict: "excellent" | "good" | "needs-review";
  transcriptPreview: string;
  missingWords: string[];
  scenes?: { index: number; title: string; similarity: number }[];
}

// ---------- text utilities ----------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "of", "for",
  "with", "by", "from", "up", "about", "into", "over", "after", "is", "are",
  "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
  "did", "will", "would", "could", "should", "may", "might", "must", "shall",
  "can", "this", "that", "these", "those", "it", "its", "as", "so", "than",
  "then", "there", "here", "we", "you", "they", "he", "she", "i",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean);
}

/**
 * Multiset word coverage: of all words the script contains, how many appear
 * in the transcript. Robust to filler/repeats and word-order differences.
 */
function wordMatch(scriptText: string, transcriptText: string) {
  const script = tokenize(scriptText);
  const spoken = new Map<string, number>();
  for (const w of tokenize(transcriptText)) spoken.set(w, (spoken.get(w) ?? 0) + 1);

  let matched = 0;
  const missing = new Map<string, number>();
  for (const w of script) {
    const left = spoken.get(w) ?? 0;
    if (left > 0) {
      matched++;
      spoken.set(w, left - 1);
    } else {
      missing.set(w, (missing.get(w) ?? 0) + 1);
    }
  }

  const missingWords = [...missing.entries()]
    .filter(([w]) => !STOPWORDS.has(w) && w.length > 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w, n]) => (n > 1 ? `${w} (x${n})` : w));

  return {
    similarity: script.length ? matched / script.length : 0,
    scriptWords: script.length,
    missingWords,
  };
}

// ---------- ASR ----------

/** Probe a media file's duration in seconds with ffprobe. */
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

/** One raw ASR call (file must be ≤ 30s — upstream hard limit). */
async function asrOnce(filePath: string): Promise<string> {
  const zai = await getZAI();
  const base64 = fs.readFileSync(filePath).toString("base64");
  const response = await aiCall("llm", "narration ASR", () =>
    zai.audio.asr.create({ file_base64: base64 })
  );
  const text = (response.text ?? "").trim();
  if (!text) throw new Error("ASR returned an empty transcript");
  return text;
}

/** Above this, audio is split into chunks (ASR caps files at 30s). */
const ASR_CHUNK_SEC = 25;

/**
 * Transcribe any-length audio: long files are split into ≤25s WAV chunks
 * (upstream accepts only WAV/WebM) with ffmpeg's segment muxer, each chunk
 * is ASR'd, transcripts joined.
 */
export async function transcribe(filePath: string): Promise<string> {
  const durationSec = await probeDurationSec(filePath);
  if (durationSec <= 28) return asrOnce(filePath);

  const chunkDir = `${filePath}.chunks-${Date.now()}`;
  fs.mkdirSync(chunkDir, { recursive: true });
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-i", filePath,
      "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      "-f", "segment", "-segment_time", String(ASR_CHUNK_SEC),
      path.join(chunkDir, "chunk-%03d.wav"),
    ]);
    const chunks = fs.readdirSync(chunkDir).sort();
    if (chunks.length === 0) throw new Error("audio chunking produced no files");

    const parts: string[] = [];
    for (const [i, chunk] of chunks.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500)); // pace ASR calls
      parts.push(await asrOnce(path.join(chunkDir, chunk)));
    }
    return parts.join(" ");
  } finally {
    fs.rmSync(chunkDir, { recursive: true, force: true });
  }
}

function verdictFor(similarity: number): VerifyReport["verdict"] {
  if (similarity >= 0.95) return "excellent";
  if (similarity >= 0.85) return "good";
  return "needs-review";
}

/**
 * Run the narration check for a video and persist the report on the row.
 * Throws when there is nothing to verify (no script / no voiceover).
 */
export async function verifyNarration(videoId: string): Promise<VerifyReport> {
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) throw new Error("Video not found");
  if (!video.script) throw new Error("Video has no script to check against");
  if (!video.hasVoiceover) throw new Error("No voiceover yet — generate it first");

  const scenes = video.format === "story" ? parseScenes(video.scenes) : [];
  const dir = path.join(UPLOAD_ROOT, videoId);

  const sceneResults: VerifyReport["scenes"] = [];
  const transcripts: string[] = [];
  const scriptParts: string[] = [];

  if (video.format === "story" && scenes.length > 0) {
    // Per-scene ASR pinpoints exactly which scene drifted.
    for (const scene of scenes) {
      const wav = path.join(dir, `scene-${String(scene.index).padStart(2, "0")}.wav`);
      if (!fs.existsSync(wav)) continue;
      const text = await transcribe(wav);
      const { similarity } = wordMatch(scene.narration, text);
      sceneResults.push({ index: scene.index, title: scene.title, similarity });
      transcripts.push(text);
      scriptParts.push(scene.narration);
    }
  }

  if (transcripts.length === 0) {
    // Classic format (or scene WAVs missing) — one pass over the merged file.
    const merged = path.join(dir, "voiceover.wav");
    if (!fs.existsSync(merged)) throw new Error("voiceover.wav is missing on disk");
    const text = await transcribe(merged);
    transcripts.push(text);
    scriptParts.push(video.script);
  }

  const transcript = transcripts.join(" ");
  const scriptText = scriptParts.join(" ");
  const { similarity, scriptWords, missingWords } = wordMatch(scriptText, transcript);
  const transcriptWords = tokenize(transcript).length;

  const report: VerifyReport = {
    ranAt: new Date().toISOString(),
    format: video.format === "story" ? "story" : "script",
    similarity: Math.round(similarity * 1000) / 1000,
    scriptWords,
    transcriptWords,
    verdict: verdictFor(similarity),
    transcriptPreview: transcript.slice(0, 600),
    missingWords,
    ...(sceneResults.length ? { scenes: sceneResults } : {}),
  };

  await db.video.update({
    where: { id: videoId },
    data: { verifyReport: JSON.stringify(report) },
  });

  const pct = Math.round(report.similarity * 100);
  await db.activity.create({
    data: {
      videoId,
      stage: "verify",
      level: report.verdict === "needs-review" ? "error" : "info",
      message: report.verdict === "needs-review"
        ? `Narration check: ${pct}% word match — needs review (missing: ${report.missingWords.slice(0, 5).join(", ") || "?"})`
        : `Narration check passed: ${pct}% word match between script and spoken audio`,
    },
  });

  return report;
}

/** Parse a stored verify report (or null). */
export function parseVerifyReport(raw: string | null): VerifyReport | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VerifyReport;
  } catch {
    return null;
  }
}
