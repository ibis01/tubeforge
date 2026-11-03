// clip-ops.ts — server-side clip operations for the Timeline Studio (S1).
//
// The Timeline Studio edits a PROJECTION of the video row; split / duplicate
// / delete are the three operations that change the ROW itself, so they are
// server operations — the client cannot invent a scene. The contract:
//
//   SPLIT      the scene's narration is divided at the playhead (word-
//              proportional inside the narration span). Both halves are
//              RE-VOICED with the same voice + speed the video already uses
//              (a fresh read, like any studio pick-up), the storyboard art
//              file is copied to the new index, and the timeline doc gains
//              the second half with a "cut" at the razor point. The old
//              scene keeps the first half; a fresh index is minted for the
//              second (indices are identity, never reused or renumbered).
//
//   DUPLICATE  an exact copy of the scene — same narration, same caption,
//              art file and WAV file copied byte-for-byte (no re-read).
//              The new seam into the copy is a "cut".
//
//   DELETE     removes the scene from the row + the timeline doc. Asset
//              files are left on disk (keyed by index, never reused — an
//              orphaned scene-XX.wav/png is inert).
//
// All three rebuild the merged voiceover.wav from the CURRENT per-scene
// WAVs in row order and update the row's audioDuration, so exports and
// future assemblies stay honest. The render needs no changes: it already
// gates on per-scene art + WAV existence and maps timeline durations onto
// the row by POSITION (sceneOrder semantics unchanged).
//
// Guards kept honest (each mirrors a render gate or a pipeline invariant):
//   • timeline doc must exist (assemble first);
//   • renderMode "slides" is refused (the deck is designed from the script
//     as a whole — a row split there needs a deck regeneration, a different
//     pipeline);
//   • split requires the built-in per-scene voiceover (voiceSource "tts") —
//     a custom-audio video would get its halves re-read by the WRONG voice;
//     duplicate/delete only copy or drop existing cuts, so they stay legal;
//   • split/duplicate require the target scene's art + WAV on disk (the
//     same files the render gate demands);
//   • delete keeps at least one scene.
//
// Pure pieces (narration split, doc surgery) are exported for unit tests;
// the orchestrator is the only part that touches fs / TTS / storage.

import fs from "fs";
import path from "path";
import type { Video } from "@prisma/client";
import { videoDir, splitForTts } from "./ai";
import { aiCall } from "./budget";
import { mergeWavs } from "./wav";
import { ttsSynthesize } from "./providers/tts";
import { sceneImageFile, sceneWavFile, parseScenes } from "./story";
import {
  parseTimeline,
  type AssembledTimeline,
  type TimelineScene,
} from "./timeline";
import { LEAD_SEC, TAIL_SEC, MIN_SEG_SEC } from "./render";
import * as storage from "./storage";
import type { Scene } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- pure: narration split ----------

/** Split a narration so the word boundary lands nearest the playhead.
 *
 * The scene window is narration-locked: the WAV occupies [LEAD, LEAD+wav]
 * of the natural window (render.ts adds the lead/tail padding). atSec is
 * the playhead's LOCAL time in the scene window. We map it into the
 * narration's interior span and split the word list proportionally.
 * Returns null when the playhead sits outside the speakable span (too
 * close to the scene's head or tail) or the narration has < 2 words. */
export function splitNarrationAt(
  narration: string,
  wavDurSec: number,
  atSec: number
): { first: string; second: string } | null {
  const words = narration.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const wav = Number.isFinite(wavDurSec) && wavDurSec > 0 ? wavDurSec : 0;
  if (wav <= 0) return null;
  // Speakable interior: leave a 0.25s guard on each side of the read so a
  // split never lands on a leading breath or the last syllable's decay.
  const lo = LEAD_SEC + 0.25;
  const hi = Math.max(lo + 0.1, LEAD_SEC + wav - 0.25);
  const t = Number.isFinite(atSec) ? atSec : -1;
  if (t < lo || t > hi) return null;
  const f = (t - lo) / (hi - lo); // 0..1
  const k = Math.min(words.length - 1, Math.max(1, Math.round(f * words.length)));
  return { first: words.slice(0, k).join(" "), second: words.slice(k).join(" ") };
}

// ---------- pure: timeline doc surgery ----------

const cloneEntry = (s: TimelineScene): TimelineScene => JSON.parse(JSON.stringify(s));

/** Walk the doc in order, recomputing start/end/total from durationSec —
 * the same shape the studio's recomputeTimes uses. 2-dp like timeline.ts. */
function recomputeDocTimes(doc: AssembledTimeline): AssembledTimeline {
  let cursor = 0;
  const scenes = doc.scenes.map((s) => {
    const dur = Math.max(0.5, s.durationSec);
    const startSec = Math.round(cursor * 100) / 100;
    const endSec = Math.round((cursor + dur) * 100) / 100;
    cursor += dur;
    return { ...s, startSec, endSec, durationSec: Math.round(dur * 100) / 100 };
  });
  return {
    ...doc,
    scenes,
    sceneCount: scenes.length,
    totalDurationSec: Math.round(cursor * 100) / 100,
    generatedAt: new Date().toISOString(),
  };
}

function docPosition(doc: AssembledTimeline, sceneIndex: number): number {
  const p = doc.scenes.findIndex((s) => s.index === sceneIndex);
  if (p < 0) throw new Error(`The timeline doc has no scene ${sceneIndex}`);
  return p;
}

/** Split entry `sceneIndex` into (sceneIndex → first half) + (nextIndex →
 * second half, "cut" at the razor point). Other entries keep their edits;
 * only their windows shift. */
export function applySplitToDoc(
  doc: AssembledTimeline,
  sceneIndex: number,
  nextIndex: number,
  durA: number,
  durB: number,
  secondNarration: string
): AssembledTimeline {
  const p = docPosition(doc, sceneIndex);
  const old = cloneEntry(doc.scenes[p]);
  const A = { ...old, durationSec: durA, transitionOut: "cut" };
  const B: TimelineScene = {
    ...old,
    index: nextIndex,
    narration: secondNarration,
    durationSec: durB,
    transitionIn: "cut",
    // A fresh scene has no director-plan entry; the camera preview is
    // index-based and the plan lookups simply miss. Copying `shot` would
    // claim a plan that does not reference this index.
    shot: null,
    caption: null,
  };
  const scenes = [...doc.scenes.slice(0, p), A, B, ...doc.scenes.slice(p + 1)];
  return recomputeDocTimes({ ...doc, scenes });
}

/** Remove the entry; the remaining windows close the gap. */
export function applyDeleteToDoc(doc: AssembledTimeline, sceneIndex: number): AssembledTimeline {
  const p = docPosition(doc, sceneIndex);
  const scenes = [...doc.scenes.slice(0, p), ...doc.scenes.slice(p + 1)];
  return recomputeDocTimes({ ...doc, scenes });
}

/** Duplicate the entry right after itself; the new seam is a "cut". */
export function applyDuplicateToDoc(
  doc: AssembledTimeline,
  sceneIndex: number,
  nextIndex: number,
  durC: number
): AssembledTimeline {
  const p = docPosition(doc, sceneIndex);
  const old = cloneEntry(doc.scenes[p]);
  const A = { ...old, transitionOut: "cut" };
  const C = { ...old, index: nextIndex, transitionIn: "cut", durationSec: durC };
  const scenes = [...doc.scenes.slice(0, p), A, C, ...doc.scenes.slice(p + 1)];
  return recomputeDocTimes({ ...doc, scenes });
}

// ---------- helpers ----------

/** The render's segment formula for a scene WAV (render.ts wavDurations). */
export function sceneSegmentSec(wavDurSec: number): number {
  return Math.max(wavDurSec + LEAD_SEC + TAIL_SEC, MIN_SEG_SEC);
}

function wavDurationOf(buf: Buffer): number {
  return mergeWavs([buf]).durationSec;
}

/** Read a scene WAV's duration straight off disk (render gate equivalent). */
function readSceneWav(dir: string, index: number): { buf: Buffer; durSec: number } {
  const p = path.join(dir, sceneWavFile(index));
  const buf = fs.readFileSync(p);
  return { buf, durSec: wavDurationOf(buf) };
}

/** One scene's narration → scene-XX.wav (mirror of generateSceneVoiceovers'
 * per-scene loop: same chunking, same pacing sleeps, same retry posture). */
async function synthSceneWav(
  dir: string,
  index: number,
  narration: string,
  voice: string,
  speed: number
): Promise<number> {
  const chunks = splitForTts(narration);
  if (chunks.length === 0) throw new Error(`Scene ${index} has nothing to speak`);
  const buffers: Buffer[] = [];
  for (const [j, chunk] of chunks.entries()) {
    if (j > 0) await sleep(2000); // pace chunks within a scene too
    const buffer = await aiCall(
      "tts",
      `scene ${index} tts (${chunk.length} chars)`,
      () => ttsSynthesize({ input: chunk, voice, speed }),
      { attempts: 6, baseDelayMs: 8000 } // outlast rate-limit storms
    );
    if (buffer.length < 44) throw new Error(`Scene ${index} TTS returned empty audio`);
    buffers.push(buffer);
  }
  const merged = mergeWavs(buffers);
  fs.writeFileSync(path.join(dir, sceneWavFile(index)), merged.buffer);
  return merged.durationSec;
}

/** Rebuild + publish the merged voiceover.wav from the CURRENT per-scene
 * WAVs in row order (the artifact the export/download routes read). Returns
 * the new total duration, or null when any WAV is missing — in that case
 * nothing is touched: the previous merged artifact + audioDuration stay
 * (a partial merge would silently truncate the export). */
async function syncVoiceover(
  videoId: string,
  dir: string,
  rowScenes: Scene[]
): Promise<number | null> {
  const buffers: Buffer[] = [];
  for (const s of rowScenes) {
    const p = path.join(dir, sceneWavFile(s.index));
    if (!fs.existsSync(p)) return null;
    buffers.push(fs.readFileSync(p));
  }
  if (buffers.length === 0) return null;
  const merged = mergeWavs(buffers);
  await storage.put(`${videoId}/voiceover.wav`, merged.buffer);
  return merged.durationSec;
}

// ---------- orchestrator ----------

export type ClipOpAction = "split" | "duplicate" | "delete";

export interface ClipOpBody {
  action: ClipOpAction;
  sceneIndex: number;
  /** Split only: the playhead's LOCAL time inside the scene window. */
  atSec?: number;
}

export interface ClipOpResult {
  rowScenes: Scene[];
  timeline: AssembledTimeline;
  sceneOrder: number[];
  /** Updated row.audioDuration (null = keep the current value). */
  audioDuration: number | null;
  /** The scene index the client should select afterwards. */
  newIndex: number | null;
  /** One-line activity message for the toast. */
  activity: string;
}

export async function performClipOp(video: Video, body: ClipOpBody): Promise<ClipOpResult> {
  if (video.format !== "story")
    throw new Error("Clip editing is for scene-format videos");
  if (video.renderMode === "slides")
    throw new Error("Clip editing is not available for slideshow videos (the deck is designed from the script as a whole)");
  const doc = parseTimeline(video.timeline);
  if (!doc) throw new Error("Assemble the timeline first");

  const dir = videoDir(video.id);
  const rowScenes = parseScenes(video.scenes);
  if (rowScenes.length === 0) throw new Error("No scenes — generate the script first");
  const p = rowScenes.findIndex((s) => s.index === body.sceneIndex);
  if (p < 0) throw new Error(`No scene ${body.sceneIndex}`);
  const target = rowScenes[p];
  const nextIndex = rowScenes.reduce((m, s) => Math.max(m, s.index), 0) + 1;

  const artPath = path.join(dir, sceneImageFile(target.index));
  const wavPath = path.join(dir, sceneWavFile(target.index));

  if (body.action === "split") {
    if (video.voiceSource !== "tts")
      throw new Error("Splitting re-voices both halves with the studio voice — re-attach the per-scene voiceover first (this video uses custom audio)");
    if (typeof body.atSec !== "number" || !Number.isFinite(body.atSec))
      throw new Error("atSec is required for split");
    if (!fs.existsSync(artPath))
      throw new Error(`Scene ${target.index} has no storyboard image — generate the storyboard first`);
    if (!fs.existsSync(wavPath))
      throw new Error(`Scene ${target.index} has no voiceover — generate the voiceover first`);

    const wavDur = readSceneWav(dir, target.index).durSec;
    const halves = splitNarrationAt(target.narration, wavDur, body.atSec);
    if (!halves)
      throw new Error("Move the playhead into the middle of the narration — the edges of a scene cannot be split");

    // Row: first half keeps the index + everything else; second half mints
    // a fresh index right after it, same art prompt/camera/mood (the same
    // SHOT continues — that is what a razor cut means), caption goes to the
    // first half only (the copy would double-burn the same line).
    rowScenes[p] = { ...target, narration: halves.first };
    const second: Scene = { ...target, index: nextIndex, narration: halves.second, caption: "" };
    rowScenes.splice(p + 1, 0, second);

    // Assets: same frame continues (byte copy); both halves re-read.
    fs.copyFileSync(artPath, path.join(dir, sceneImageFile(nextIndex)));
    const wavDurA = await synthSceneWav(dir, target.index, halves.first, video.voice, video.ttsSpeed);
    const wavDurB = await synthSceneWav(dir, nextIndex, halves.second, video.voice, video.ttsSpeed);

    const nextDoc = applySplitToDoc(
      doc,
      target.index,
      nextIndex,
      sceneSegmentSec(wavDurA),
      sceneSegmentSec(wavDurB),
      halves.second
    );

    const merged = await syncVoiceover(video.id, dir, rowScenes);
    return {
      rowScenes,
      timeline: nextDoc,
      sceneOrder: rowScenes.map((s) => s.index),
      audioDuration: merged,
      newIndex: nextIndex,
      activity: `Scene ${target.index} split at ${body.atSec.toFixed(1)}s — both halves re-voiced (${halves.first.split(/\s+/).length}/${halves.second.split(/\s+/).length} words)${merged === null ? "; voiceover.wav not rebuilt (a scene WAV is missing)" : ""}`,
    };
  }

  if (body.action === "duplicate") {
    if (!fs.existsSync(artPath))
      throw new Error(`Scene ${target.index} has no storyboard image — generate the storyboard first`);
    if (!fs.existsSync(wavPath))
      throw new Error(`Scene ${target.index} has no voiceover — generate the voiceover first`);

    // Row: an exact copy (same caption — the user edits the copy after).
    const copy: Scene = { ...target, index: nextIndex };
    rowScenes.splice(p + 1, 0, copy);

    // Assets: byte copies — the duplicate says the same words, same read.
    fs.copyFileSync(artPath, path.join(dir, sceneImageFile(nextIndex)));
    fs.copyFileSync(wavPath, path.join(dir, sceneWavFile(nextIndex)));
    const wavDur = readSceneWav(dir, nextIndex).durSec;

    const nextDoc = applyDuplicateToDoc(doc, target.index, nextIndex, sceneSegmentSec(wavDur));

    const merged = await syncVoiceover(video.id, dir, rowScenes);
    return {
      rowScenes,
      timeline: nextDoc,
      sceneOrder: rowScenes.map((s) => s.index),
      audioDuration: merged,
      newIndex: nextIndex,
      activity: `Scene ${target.index} duplicated as scene ${nextIndex} (${sceneSegmentSec(wavDur).toFixed(1)}s, same read)${merged === null ? "; voiceover.wav not rebuilt (a scene WAV is missing)" : ""}`,
    };
  }

  // delete
  if (rowScenes.length < 2) throw new Error("A video needs at least one scene — delete refused");
  rowScenes.splice(p, 1);
  const nextDoc = applyDeleteToDoc(doc, target.index);
  const merged = await syncVoiceover(video.id, dir, rowScenes);
  return {
    rowScenes,
    timeline: nextDoc,
    sceneOrder: rowScenes.map((s) => s.index),
    audioDuration: merged,
    newIndex: null,
    activity: `Scene ${target.index} removed — ${nextDoc.sceneCount} scenes, ${nextDoc.totalDurationSec.toFixed(1)}s${merged === null ? "; voiceover.wav not rebuilt (a scene WAV is missing)" : ""}`,
  };
}
