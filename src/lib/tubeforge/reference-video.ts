// reference-video.ts — S88: Reference-video intelligence (the S76 §5 P1).
//
// The law this module serves (the adoption decision §5 P1): accept a
// reference video the user has the rights to learn from; extract its
// STRUCTURE — scene boundaries, shot durations and pacing, representative
// frames, transcript, visual treatment, hook and narrative shape — and
// feed the Director the ABSTRACT characteristics so it can produce an
// ORIGINAL concept that mirrors the structure, never the expression.
// Structural patterns, never copyrighted footage, scripts or distinctive
// expression: the transcript stays server-side as analysis input; what
// reaches the Director prompt is pacing profiles, beat roles and
// treatment adjectives (referenceBlockForPrompt is pinned to never emit
// the transcript text).
//
// Ingestion rights (v1, recorded): UPLOAD only — the user attests rights
// by uploading their own file; a URL fetcher is deliberately deferred
// (platform terms + the SSRF surface a fetcher opens). Every analysis
// runs on a file that already sits in OUR storage.
//
// The doc laws (the house discipline): versioned (a build reads N,
// refuses unknown), tolerant parse (null on unreadable, junk keys
// tolerated), strict write (exactly the declared fields, version first).
import { execFile } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "util";

import { aiCall } from "./budget";
import { llmChat, llmVision } from "./llm";
import { log } from "./log";
import { parseSceneCuts } from "./render-qc";
import { transcribe } from "./verify";
import * as storage from "./storage";

const refLog = log.child({ mod: "reference-video" });

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// The doc
// ---------------------------------------------------------------------------

export interface ReferenceSceneWindow {
  startSec: number;
  endSec: number;
  /** Storage key of the mid-window keyframe (null = extraction failed). */
  keyframeKey: string | null;
}

export interface ReferencePacing {
  cutCount: number;
  meanShotSec: number;
  medianShotSec: number;
  cutsPerMin: number;
  /** The profile the Director prompt names — thresholds documented below. */
  profile: "slow" | "measured" | "fast" | "very fast";
}

export interface ReferenceTranscript {
  text: string;
  wordCount: number;
  wordsPerSec: number;
}

export interface ReferenceTreatment {
  camera: string;
  color: string;
  onScreenText: string;
  summary: string;
}

export interface ReferenceBeat {
  role: string;
  startSec: number;
  endSec: number;
}

export interface ReferenceStructure {
  hookPattern: string | null;
  beats: ReferenceBeat[];
  /** "llm" = the structure pass labeled the beats; "deterministic" = the
   *  fail-open thirds (hook/body/close) when the LLM was unavailable. */
  source: "llm" | "deterministic";
}

export interface ReferenceAnalysis {
  version: 1;
  source: {
    fileName: string;
    durationSec: number;
    width: number;
    height: number;
    fps: number;
    hasAudio: boolean;
  };
  analyzedAt: string;
  sceneMap: ReferenceSceneWindow[];
  pacing: ReferencePacing;
  transcript: ReferenceTranscript | null;
  treatment: ReferenceTreatment | null;
  structure: ReferenceStructure;
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Tolerant parse — null on unreadable/unknown-version docs (the house
 *  law: never a guessed parse; a newer doc reads as absent and is never
 *  overwritten by an older build's write). */
export function parseReferenceAnalysis(
  raw: string | null | undefined
): ReferenceAnalysis | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    if (rec.version !== 1) return null; // unknown version — refuse, never guess
    const src = (rec.source ?? {}) as Record<string, unknown>;
    const pacing = (rec.pacing ?? {}) as Record<string, unknown>;
    const structure = (rec.structure ?? {}) as Record<string, unknown>;
    const transcript = rec.transcript as Record<string, unknown> | null | undefined;
    const treatment = rec.treatment as Record<string, unknown> | null | undefined;
    const sceneMap = Array.isArray(rec.sceneMap) ? rec.sceneMap : [];
    const beats = Array.isArray(structure.beats) ? structure.beats : [];
    return {
      version: 1,
      source: {
        fileName: typeof src.fileName === "string" ? src.fileName : "reference",
        durationSec: num(src.durationSec),
        width: Math.round(num(src.width)),
        height: Math.round(num(src.height)),
        fps: num(src.fps),
        hasAudio: src.hasAudio === true,
      },
      analyzedAt: typeof rec.analyzedAt === "string" ? rec.analyzedAt : new Date().toISOString(),
      sceneMap: sceneMap.map((w) => {
        const r = (w ?? {}) as Record<string, unknown>;
        return {
          startSec: num(r.startSec),
          endSec: num(r.endSec),
          keyframeKey: typeof r.keyframeKey === "string" ? r.keyframeKey : null,
        };
      }),
      pacing: {
        cutCount: Math.round(num(pacing.cutCount)),
        meanShotSec: num(pacing.meanShotSec),
        medianShotSec: num(pacing.medianShotSec),
        cutsPerMin: num(pacing.cutsPerMin),
        profile: pacingProfile(num(pacing.cutsPerMin)),
      },
      transcript:
        transcript && typeof transcript.text === "string"
          ? {
              text: transcript.text,
              wordCount: Math.round(num(transcript.wordCount, transcript.text.split(/\s+/).filter(Boolean).length)),
              wordsPerSec: num(transcript.wordsPerSec),
            }
          : null,
      treatment:
        treatment && typeof treatment.summary === "string"
          ? {
              camera: typeof treatment.camera === "string" ? treatment.camera : "",
              color: typeof treatment.color === "string" ? treatment.color : "",
              onScreenText: typeof treatment.onScreenText === "string" ? treatment.onScreenText : "",
              summary: treatment.summary,
            }
          : null,
      structure: {
        hookPattern: typeof structure.hookPattern === "string" ? structure.hookPattern : null,
        beats: beats.map((b) => {
          const r = (b ?? {}) as Record<string, unknown>;
          return {
            role: typeof r.role === "string" ? r.role : "beat",
            startSec: num(r.startSec),
            endSec: num(r.endSec),
          };
        }),
        source: structure.source === "llm" ? "llm" : "deterministic",
      },
    };
  } catch {
    return null;
  }
}

/** Strict write — exactly the declared fields, version first (the
 *  TIMELINE_SCENE_FIELDS discipline). */
export function serializeReferenceAnalysis(a: ReferenceAnalysis): string {
  return JSON.stringify({
    version: 1,
    source: {
      fileName: a.source.fileName,
      durationSec: a.source.durationSec,
      width: a.source.width,
      height: a.source.height,
      fps: a.source.fps,
      hasAudio: a.source.hasAudio,
    },
    analyzedAt: a.analyzedAt,
    sceneMap: a.sceneMap.map((w) => ({
      startSec: w.startSec,
      endSec: w.endSec,
      keyframeKey: w.keyframeKey,
    })),
    pacing: { ...a.pacing },
    ...(a.transcript
      ? {
          transcript: {
            text: a.transcript.text,
            wordCount: a.transcript.wordCount,
            wordsPerSec: a.transcript.wordsPerSec,
          },
        }
      : {}),
    ...(a.treatment ? { treatment: { ...a.treatment } } : {}),
    structure: {
      hookPattern: a.structure.hookPattern,
      beats: a.structure.beats.map((b) => ({
        role: b.role,
        startSec: b.startSec,
        endSec: b.endSec,
      })),
      source: a.structure.source,
    },
  });
}

// ---------------------------------------------------------------------------
// The pure layer (pinned)
// ---------------------------------------------------------------------------

/** The pacing profile thresholds (documented law): <6 cuts/min reads as a
 *  slow contemplative cut; 6–12 measured (the documentary norm); 12–24
 *  fast (the YouTube edit norm); >24 very fast (the Shorts/MTV cut). */
export function pacingProfile(cutsPerMin: number): ReferencePacing["profile"] {
  if (cutsPerMin < 6) return "slow";
  if (cutsPerMin < 12) return "measured";
  if (cutsPerMin < 24) return "fast";
  return "very fast";
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pacing stats from detected cut times — pure, deterministic. Cuts are
 *  sorted, de-duplicated within 0.3s (the detector can double-fire on a
 *  flash frame), and clamped to the video's span. */
export function pacingStats(
  cutTimesSec: number[],
  durationSec: number
): ReferencePacing {
  const span = durationSec > 0 ? durationSec : 0;
  const cuts = [...cutTimesSec]
    .filter((t) => Number.isFinite(t) && t > 0.3 && t < Math.max(0.31, span - 0.3))
    .sort((a, b) => a - b)
    .filter((t, i, arr) => i === 0 || t - arr[i - 1] > 0.3);
  const shots = [0, ...cuts, span].filter(
    (t, i, arr) => i === 0 || t > arr[i - 1]
  );
  const durations: number[] = [];
  for (let i = 0; i + 1 < shots.length; i++) {
    const d = shots[i + 1] - shots[i];
    if (d > 0) durations.push(d);
  }
  const cutCount = cuts.length;
  const cutsPerMin = span > 0 ? (cutCount / span) * 60 : 0;
  return {
    cutCount,
    meanShotSec: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : span,
    medianShotSec: median(durations),
    cutsPerMin: Math.round(cutsPerMin * 10) / 10,
    profile: pacingProfile(cutsPerMin),
  };
}

/** Scene windows from cuts — pure. The last window closes at the video's
 *  duration; degenerate spans (no cuts, zero duration) yield one window. */
export function sceneWindowsFromCuts(
  cutTimesSec: number[],
  durationSec: number
): { startSec: number; endSec: number }[] {
  const span = durationSec > 0 ? durationSec : 0;
  const cuts = [...cutTimesSec]
    .filter((t) => Number.isFinite(t) && t > 0.3 && t < Math.max(0.31, span - 0.3))
    .sort((a, b) => a - b)
    .filter((t, i, arr) => i === 0 || t - arr[i - 1] > 0.3);
  const edges = [0, ...cuts, span];
  const out: { startSec: number; endSec: number }[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    if (edges[i + 1] - edges[i] > 0.05)
      out.push({ startSec: edges[i], endSec: edges[i + 1] });
  }
  if (out.length === 0 && span > 0) out.push({ startSec: 0, endSec: span });
  return out;
}

/** The fail-open structure: deterministic thirds (hook = the first shot
 *  window or the first 8s, whichever is shorter; body; close). The LLM
 *  pass replaces the labels, not the windows, when it runs. */
export function deterministicBeats(
  windows: { startSec: number; endSec: number }[]
): ReferenceBeat[] {
  if (windows.length === 0) return [];
  const end = windows[windows.length - 1].endSec;
  const hookEnd = Math.min(windows[0].endSec, Math.max(4, Math.min(8, end * 0.2)));
  const closeStart = windows.length > 1 ? Math.max(hookEnd, end * 0.85) : end;
  return [
    { role: "hook", startSec: 0, endSec: hookEnd },
    { role: "body", startSec: hookEnd, endSec: closeStart },
    { role: "close", startSec: closeStart, endSec: end },
  ].filter((b) => b.endSec > b.startSec);
}

/**
 * The ABSTRACT block the Director prompt carries — THE copyright wall.
 * Pinned: the block contains pacing numbers, beat roles and windows, the
 * treatment adjectives and the transcript's DENSITY (words/sec), never
 * the transcript text, never the source's words.
 */
export function referenceBlockForPrompt(a: ReferenceAnalysis): string {
  const lines = [
    `Reference structure (mirror the PATTERNS, never the words or footage):`,
    `pacing: ${a.pacing.profile} (${a.pacing.cutCount} cuts, ~${a.pacing.medianShotSec.toFixed(1)}s median shot, ${a.pacing.cutsPerMin} cuts/min).`,
  ];
  if (a.structure.hookPattern)
    lines.push(`hook pattern: ${a.structure.hookPattern} (an abstract shape, not a line to reuse).`);
  const beats = a.structure.beats
    .map((b) => `${b.role} ${Math.round(b.startSec)}-${Math.round(b.endSec)}s`)
    .join(" | ");
  if (beats) lines.push(`beat map: ${beats}.`);
  if (a.transcript)
    lines.push(
      `narration density: ~${a.transcript.wordsPerSec.toFixed(1)} words/sec across ${a.sceneMap.length} scene${a.sceneMap.length === 1 ? "" : "s"}.`
    );
  if (a.treatment)
    lines.push(
      `visual treatment: camera ${a.treatment.camera}; color ${a.treatment.color}; on-screen text ${a.treatment.onScreenText}.`
    );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The extraction pipeline (job body; ffmpeg + one ASR + one VLM + one LLM)
// ---------------------------------------------------------------------------

/** Analysis walls — the honest limits (recorded in the design doc): a
 *  20-minute reference is plenty of structure to learn from; longer
 *  uploads are refused rather than silently truncated. */
export const REFERENCE_MAX_DURATION_SEC = 20 * 60;
export const REFERENCE_MAX_BYTES = 200 * 1024 * 1024;
/** The scene-detect threshold — 0.30 (slightly more sensitive than the
 *  QC lens's 0.40): reference videos cut between heterogeneous footage,
 *  but soft dissolves must not double-book as cuts. */
const REFERENCE_SCENE_THRESHOLD = 0.3;
/** Keyframes per analysis (storage-bounded; the VLM sees at most 6). */
export const REFERENCE_KEYFRAMES = 8;
const REFERENCE_VLM_FRAMES = 6;

export interface AnalyzeReferenceOptions {
  fileName: string;
  onProgress?: (label: string) => void;
}

async function runFfmpeg(args: string[]): Promise<string> {
  const { stderr } = await execFileP("ffmpeg", ["-y", "-v", "info", ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stderr;
}

interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

async function probeReference(file: string): Promise<ProbeResult | null> {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate",
      "-of", "json",
      file,
    ]);
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string }[];
    };
    const streams = parsed.streams ?? [];
    const v = streams.find((s) => s.codec_type === "video");
    if (!v) return null;
    const [n, d] = (v.avg_frame_rate ?? "0/1").split("/").map(Number);
    const fps = d > 0 ? n / d : 0;
    return {
      durationSec: Number(parsed.format?.duration ?? NaN) || 0,
      width: v.width ?? 0,
      height: v.height ?? 0,
      fps: Number.isFinite(fps) ? Math.round(fps * 100) / 100 : 0,
      hasAudio: streams.some((s) => s.codec_type === "audio"),
    };
  } catch {
    return null;
  }
}

const TREATMENT_SYSTEM =
  "You are a film-language analyst. You see sampled keyframes from ONE reference video, in time order. " +
  "Describe the video's ABSTRACT visual treatment in STRICT JSON with exactly these keys: " +
  '"camera" (camera-movement style in <=12 words), "color" (color treatment in <=12 words), ' +
  '"onScreenText" (how on-screen text is used in <=12 words), "summary" (the overall visual grammar in <=30 words). ' +
  "Describe PATTERNS and TECHNIQUE only — never transcribe visible text verbatim, never describe specific people or brands. " +
  'Reply with the JSON object and nothing else.';

interface TreatmentReply {
  camera: string;
  color: string;
  onScreenText: string;
  summary: string;
}

async function analyzeTreatment(
  frames: { key: string; buf: Buffer }[]
): Promise<TreatmentReply | null> {
  if (frames.length === 0) return null;
  const parts: unknown[] = [
    { type: "text", text: `Keyframes from one reference video, in time order (first to last):` },
  ];
  for (const f of frames.slice(0, REFERENCE_VLM_FRAMES)) {
    parts.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${f.buf.toString("base64")}` },
    });
  }
  try {
    const raw = await aiCall("llm", "reference treatment VLM", () =>
      llmVision({
        messages: [
          { role: "system", content: TREATMENT_SYSTEM },
          { role: "user", content: parts },
        ],
        temperature: 0.2,
      })
    );
    const content = raw.choices?.[0]?.message?.content ?? "";
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as Partial<TreatmentReply>;
    if (typeof parsed.summary !== "string") return null;
    return {
      camera: typeof parsed.camera === "string" ? parsed.camera.slice(0, 120) : "",
      color: typeof parsed.color === "string" ? parsed.color.slice(0, 120) : "",
      onScreenText: typeof parsed.onScreenText === "string" ? parsed.onScreenText.slice(0, 120) : "",
      summary: parsed.summary.slice(0, 300),
    };
  } catch (err) {
    refLog.warn("reference treatment VLM failed — analysis continues without it", {
      err: String(err).slice(0, 160),
    });
    return null;
  }
}

const STRUCTURE_SYSTEM =
  "You are a narrative-structure analyst. You receive ABSTRACT data about one reference video: its scene map " +
  "(window lengths), pacing stats, per-window narration density, and (when available) its transcript — the transcript " +
  "is analysis input ONLY. Identify the video's structural shape: how the opening hooks, how the middle is organized, " +
  "how it closes. Reply in STRICT JSON with exactly these keys: " +
  '"hookPattern" (the opening\'s structural trick in <=20 words — e.g. "cold-open question, answer withheld until the close"), ' +
  '"beats" (3-6 objects, each {"role": "<one-word role like hook|context|build|payoff|close>", "startSec": <number>, "endSec": <number>}). ' +
  "Beat windows must tile the video's span. NEVER copy sentences from the transcript into your reply — name shapes, not words. " +
  'Reply with the JSON object and nothing else.';

interface StructureReply {
  hookPattern: string | null;
  beats: ReferenceBeat[];
}

async function analyzeStructure(
  a: Pick<ReferenceAnalysis, "sceneMap" | "pacing" | "source">,
  transcript: ReferenceTranscript | null
): Promise<StructureReply | null> {
  const facts: string[] = [
    `duration: ${a.source.durationSec.toFixed(1)}s across ${a.sceneMap.length} scene window${a.sceneMap.length === 1 ? "" : "s"}.`,
    `pacing: ${a.pacing.profile}, ${a.pacing.cutCount} cuts, median shot ${a.pacing.medianShotSec.toFixed(1)}s.`,
    `scene windows: ${a.sceneMap.map((w) => `${Math.round(w.startSec)}-${Math.round(w.endSec)}s`).join(", ")}.`,
  ];
  if (transcript) {
    facts.push(`narration: ~${transcript.wordsPerSec.toFixed(1)} words/sec overall.`);
    // Per-window density — the shape of the delivery, not its content.
    const words = transcript.text.split(/\s+/).filter(Boolean);
    const per = a.sceneMap.map((w) => {
      const from = Math.floor((w.startSec / Math.max(0.01, a.source.durationSec)) * words.length);
      const to = Math.max(from, Math.ceil((w.endSec / Math.max(0.01, a.source.durationSec)) * words.length));
      return `${Math.round(w.startSec)}-${Math.round(w.endSec)}s: ${Math.max(0, to - from)} words`;
    });
    facts.push(`per-window word counts (density only): ${per.join("; ")}.`);
    facts.push(`transcript (analysis input only — never copy its sentences): ${transcript.text.slice(0, 6000)}`);
  }
  try {
    const raw = await aiCall("llm", "reference structure pass", () =>
      llmChat({
        messages: [
          { role: "system", content: STRUCTURE_SYSTEM },
          { role: "user", content: facts.join("\n") },
        ],
        temperature: 0.2,
      })
    );
    const content = raw.choices?.[0]?.message?.content ?? "";
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as {
      hookPattern?: unknown;
      beats?: { role?: unknown; startSec?: unknown; endSec?: unknown }[];
    };
    const beats = Array.isArray(parsed.beats)
      ? parsed.beats
          .filter((b) => b && typeof b.role === "string")
          .map((b) => ({
            role: String(b.role).slice(0, 40),
            startSec: Number(b.startSec) || 0,
            endSec: Number(b.endSec) || 0,
          }))
          .filter((b) => b.endSec > b.startSec)
      : [];
    if (beats.length < 2) return null;
    return {
      hookPattern:
        typeof parsed.hookPattern === "string" ? parsed.hookPattern.slice(0, 200) : null,
      beats,
    };
  } catch (err) {
    refLog.warn("reference structure pass failed — the deterministic beats stand", {
      err: String(err).slice(0, 160),
    });
    return null;
  }
}

/**
 * The full analysis pipeline. NEVER throws for a missing AI pass (ASR,
 * VLM, structure all fail open); throws ONLY for honestly-broken input
 * (unreadable file, over the duration wall) so the job card can show the
 * user a readable error.
 */
export async function analyzeReferenceVideo(
  videoId: string,
  filePath: string,
  opts: AnalyzeReferenceOptions
): Promise<ReferenceAnalysis> {
  opts.onProgress?.("Probing the reference video");
  const probe = await probeReference(filePath);
  if (!probe || probe.durationSec <= 0) {
    throw new Error("The reference file has no readable video stream — upload a standard MP4/MOV/WEBM");
  }
  if (probe.durationSec > REFERENCE_MAX_DURATION_SEC) {
    throw new Error(
      `The reference video is ${(probe.durationSec / 60).toFixed(0)} minutes — the analysis wall is ${REFERENCE_MAX_DURATION_SEC / 60} (trim it first)`
    );
  }

  // 1) Scene boundaries — the QC battery's own detector, slightly more
  //    sensitive (reference footage is heterogeneous; dissolves must not
  //    double-book).
  opts.onProgress?.("Detecting scene boundaries");
  const detectStderr = await runFfmpeg([
    "-i", filePath,
    "-vf", `select=gt(scene\\,${REFERENCE_SCENE_THRESHOLD}),showinfo`,
    "-f", "null", "-",
  ]);
  const cuts = parseSceneCuts(detectStderr);
  const windows = sceneWindowsFromCuts(cuts, probe.durationSec);

  return buildAnalysis({
    videoId,
    filePath,
    fileName: opts.fileName,
    probe,
    cuts,
    windows,
    onProgress: opts.onProgress,
  });
}

/** The shared tail: keyframes via temp files (image2 pipe quirks), ASR,
 *  treatment, structure, doc assembly. Split from analyzeReferenceVideo
 *  only for readability; one call path. */
async function buildAnalysis(input: {
  videoId: string;
  filePath: string;
  fileName: string;
  probe: ProbeResult;
  cuts: number[];
  windows: { startSec: number; endSec: number }[];
  onProgress?: (label: string) => void;
}): Promise<ReferenceAnalysis> {
  const { videoId, filePath, probe, windows, onProgress } = input;
  const os = await import("node:os");

  // Keyframes (temp file then storage put — the honest pipe-free path).
  const sceneMap: ReferenceSceneWindow[] = [];
  const frameBufs: { buf: Buffer; idx: number }[] = [];
  const step = Math.max(1, Math.ceil(windows.length / REFERENCE_KEYFRAMES));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-ref-"));
  try {
    let kf = 0;
    for (let i = 0; i < windows.length; i += step) {
      const w = windows[i];
      const mid = (w.startSec + w.endSec) / 2;
      const tmp = path.join(tmpDir, `kf-${kf}.jpg`);
      try {
        await runFfmpeg([
          "-ss", mid.toFixed(3),
          "-i", filePath,
          "-frames:v", "1",
          "-vf", "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'",
          "-q:v", "4",
          tmp,
        ]);
        const buf = fs.readFileSync(tmp);
        const key = `${videoId}/reference/keyframe-${i}.jpg`;
        await storage.put(key, buf);
        sceneMap.push({ startSec: w.startSec, endSec: w.endSec, keyframeKey: key });
        frameBufs.push({ buf, idx: i });
      } catch {
        sceneMap.push({ startSec: w.startSec, endSec: w.endSec, keyframeKey: null });
      }
      kf++;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 3) Transcript — the existing ASR seam, fail-open.
  let transcript: ReferenceTranscript | null = null;
  if (probe.hasAudio) {
    onProgress?.("Transcribing the reference audio");
    const wavPath = path.join(tmpDir, "audio.wav");
    try {
      await runFfmpeg([
        "-i", filePath,
        "-vn", "-ar", "16000", "-ac", "1",
        "-c:a", "pcm_s16le",
        wavPath,
      ]);
      const text = await transcribe(wavPath);
      const words = text.trim().split(/\s+/).filter(Boolean);
      if (words.length > 0) {
        transcript = {
          text: text.trim(),
          wordCount: words.length,
          wordsPerSec: Math.round((words.length / Math.max(1, probe.durationSec)) * 10) / 10,
        };
      }
    } catch (err) {
      refLog.warn("reference ASR failed — analysis continues without a transcript", {
        err: String(err).slice(0, 160),
      });
    }
  }

  // 4) Visual treatment — ONE batched VLM call over sampled keyframes.
  onProgress?.("Reading the visual treatment");
  const treatment =
    (await analyzeTreatment(frameBufs.map((f) => ({ key: "", buf: f.buf })))) ?? null;

  // 5) Structure — the LLM labels the beats; the deterministic thirds
  //    stand when it cannot (fail-open, source-labeled).
  onProgress?.("Mapping the narrative structure");
  const pacing = pacingStats(input.cuts, probe.durationSec);
  const llmStructure = await analyzeStructure(
    { sceneMap, pacing, source: { ...probe, fileName: input.fileName } },
    transcript
  );
  const structure: ReferenceStructure = llmStructure
    ? { hookPattern: llmStructure.hookPattern, beats: llmStructure.beats, source: "llm" }
    : { hookPattern: null, beats: deterministicBeats(windows), source: "deterministic" };

  return {
    version: 1,
    source: {
      fileName: input.fileName,
      durationSec: Math.round(probe.durationSec * 100) / 100,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
    },
    analyzedAt: new Date().toISOString(),
    sceneMap,
    pacing,
    transcript,
    treatment,
    structure,
  };
}

// ---------------------------------------------------------------------------
// The job body (the character-jobs pattern: the domain module owns its job)
// ---------------------------------------------------------------------------

/** The source upload's storage key (one reference per video, replaced on
 *  every re-upload — the newest reference is the only one that matters). */
export function referenceSourceKey(videoId: string, ext: string): string {
  return `${videoId}/reference/source.${ext}`;
}

/** List the reference namespace's storage keys (source + keyframes) — the
 *  DELETE route's sweep and the re-upload's cleanup both consume it. */
export function referenceNamespaceKeys(videoId: string): string[] {
  return [
    `${videoId}/reference/source.mp4`,
    `${videoId}/reference/source.mov`,
    `${videoId}/reference/source.webm`,
    `${videoId}/reference/source.mkv`,
    `${videoId}/reference/source.m4v`,
    ...Array.from({ length: REFERENCE_KEYFRAMES * 4 }, (_, i) => `${videoId}/reference/keyframe-${i}.jpg`),
  ];
}

/**
 * The analysis job: materialize the stored source, run the pipeline, land
 * the doc on the row. AI passes fail open (the doc still lands with nulls
 * and the deterministic beats); only honestly-broken input fails the job
 * with a readable error (the probe walls inside analyzeReferenceVideo).
 */
export async function runReferenceAnalysisJob(videoId: string): Promise<void> {
  const { db } = await import("./tenant-db");
  const { assertCtx } = await import("./tenant");
  const { setJobProgress } = await import("./jobs");
  const ctx = assertCtx("runReferenceAnalysisJob");
  void ctx;

  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return; // deleted while queued — end quietly

  // The newest source in the namespace (the route stores exactly one).
  let srcPath: string | null = null;
  let srcKey: string | null = null;
  for (const key of referenceNamespaceKeys(videoId)) {
    const exists = await storage.exists(key).catch(() => false);
    if (exists) {
      srcKey = key;
      srcPath = await storage.materialize(key);
      break;
    }
  }
  if (!srcPath || !srcKey) {
    throw new Error("No reference video stored — upload one first");
  }

  try {
    const analysis = await analyzeReferenceVideo(videoId, srcPath, {
      fileName: path.basename(srcKey),
      onProgress: (label) => setJobProgress(videoId, "reference", 0, 1, label),
    });
    await db.video.update({
      where: { id: videoId },
      data: { referenceAnalysis: serializeReferenceAnalysis(analysis), error: null },
    });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "reference",
        message:
          `Reference analyzed — ${analysis.source.durationSec.toFixed(0)}s, ${analysis.pacing.cutCount} cuts (${analysis.pacing.profile}), ` +
          `${analysis.sceneMap.length} scene window${analysis.sceneMap.length === 1 ? "" : "s"}, ` +
          `${analysis.transcript ? `transcript ${analysis.transcript.wordCount} words` : "no transcript"}, ` +
          `${analysis.treatment ? "treatment read" : "treatment unavailable"}, ` +
          `structure ${analysis.structure.source}`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.video.update({ where: { id: videoId }, data: { error: `Reference analysis failed: ${message}` } });
    await db.activity
      .create({
        data: {
          organizationId: video.organizationId,
          userId: ctx.userId,
          videoId,
          stage: "reference",
          level: "error",
          message: `Reference analysis failed: ${message}`,
        },
      })
      .catch(() => {});
    throw err;
  }
}
