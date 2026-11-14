// K1 slice 1 — the 2D character-engine substrate: pure pose evaluation and
// the beat-sync mouth schedule (S120 §6). Two consumers, one measured rung:
//
//   poseAt        — keyframed POSE states over the scene clock, blended with
//                   the shared anim easings (the anim/keyframe convention:
//                   the SEGMENT's ease is named on the DESTINATION key);
//   buildMouthBeats — the HONEST narration-sync: open/close beats paced by
//                   syllable counts INSIDE each measured word span (the W4
//                   word anchors' ms space). This is beat-sync, NOT phoneme
//                   lip-sync — scope-claimed as "beat-sync" in all docs/UI.
//
// Laws: pure — no fs, no clock, no randomness (S64); every refusal names
// its reason; every rig part is present in every frame (rest-filled, never
// NaN); the mouth schedule rides the same monotone measured-stream law as
// the captions cues; a NaN clock reads closed, never NaN.
import { evalEase, isEaseName, type EaseName } from "../anim/easing";
import { validateRigDoc, type CharacterRigDoc } from "./rig2d";
import type { RigPose } from "./rig2d";
import type { MouthShape } from "./rig2d";
import type { AsrWord } from "../providers/asr";

/** One part's resolved LOCAL state at a t: the rest placement with the
 *  pose's offsets applied (rotateDeg/x/y additive, scale multiplicative).
 *  The renderer composes these down the parent chain (slice 3) — this
 *  module's contract is the LOCAL truth. */
export interface RigPartState {
  rotateDeg: number;
  x: number;
  y: number;
  scale: number;
}

export interface RigFrameState {
  tMs: number;
  /** Every rig part, rest-filled — a part a pose never mentions is still
   *  present at rest (never NaN, never missing). */
  parts: Record<string, RigPartState>;
}

/** One pose keyframe: WHERE (tMs) and WHICH pose (poseId). The SEGMENT'S
 *  ease is named on the DESTINATION key — the anim/keyframe convention
 *  every consumer shares. */
export interface PoseKey {
  tMs: number;
  poseId: string;
  ease?: EaseName;
}

export interface PoseTimeline {
  keys: PoseKey[];
}

function restState(rig: CharacterRigDoc): Record<string, RigPartState> {
  const out: Record<string, RigPartState> = {};
  for (const part of rig.parts) {
    out[part.id] = {
      rotateDeg: part.rest.rotateDeg ?? 0,
      x: part.rest.x,
      y: part.rest.y,
      scale: part.rest.scale ?? 1,
    };
  }
  return out;
}

function poseById(rig: CharacterRigDoc, poseId: string): RigPose {
  const pose = rig.poses.find((p) => p.id === poseId);
  if (!pose) {
    throw new Error(`pose "${poseId}" is not in the rig — the rig knows: ${rig.poses.map((p) => p.id).join("|") || "(none)"}`);
  }
  return pose;
}

/** Resolve one pose onto the full part set: rest everywhere, then the
 *  pose's offsets applied. Pure, deterministic. */
function resolvePose(rig: CharacterRigDoc, pose: RigPose): Record<string, RigPartState> {
  const state = restState(rig);
  for (const [partId, joint] of Object.entries(pose.joints)) {
    const cur = state[partId];
    if (!cur) continue; // validateRigDoc refuses unknown parts; tolerant here
    if (joint.rotateDeg !== undefined) cur.rotateDeg += joint.rotateDeg;
    if (joint.x !== undefined) cur.x += joint.x;
    if (joint.y !== undefined) cur.y += joint.y;
    if (joint.scale !== undefined) cur.scale *= joint.scale;
  }
  return state;
}

/**
 * validatePoseTimeline — the keys' ONE law: ascending finite times on the
 * scene clock, pose ids that exist, eases from the shared table. Junk input
 * is a caller bug — refuse loudly (the anim/keyframe law, generalized).
 */
export function validatePoseTimeline(rig: CharacterRigDoc, timeline: PoseTimeline): void {
  if (!timeline || !Array.isArray(timeline.keys)) {
    throw new Error("the pose timeline needs a keys array (empty is allowed — the rig holds REST)");
  }
  let prev = -Infinity;
  for (let i = 0; i < timeline.keys.length; i++) {
    const key = timeline.keys[i];
    if (!key || typeof key !== "object") {
      throw new Error(`pose key ${i} must be an object`);
    }
    if (typeof key.tMs !== "number" || !Number.isFinite(key.tMs) || key.tMs < 0) {
      throw new Error(`pose key ${i} needs a finite tMs >= 0 (got ${String(key.tMs)})`);
    }
    if (key.tMs <= prev) {
      throw new Error(
        `pose keys must strictly ascend (key ${i} at ${String(key.tMs)}ms after ${String(prev)}ms) — sort them or merge the duplicates`,
      );
    }
    prev = key.tMs;
    if (typeof key.poseId !== "string" || key.poseId.trim() === "") {
      throw new Error(`pose key ${i} needs a non-empty poseId`);
    }
    poseById(rig, key.poseId); // names the known poses in its refusal
    if (key.ease !== undefined && !isEaseName(key.ease)) {
      throw new Error(`pose key ${i} names unknown ease "${String(key.ease)}" — the table is linear|ease-in-out|ease-out|pop|ease-back`);
    }
  }
}

/**
 * poseAt — the clamped, eased pose evaluation: before the first key → the
 * first key's pose; after the last → the last key's pose; between → the
 * destination key's eased blend of the two RESOLVED states. Every rig part
 * is in the output at every t (rest-filled). Pure and deterministic (S64).
 */
export function poseAt(rig: CharacterRigDoc, timeline: PoseTimeline, tMs: number): RigFrameState {
  validateRigDoc(rig);
  validatePoseTimeline(rig, timeline);
  if (typeof tMs !== "number" || !Number.isFinite(tMs) || tMs < 0) {
    throw new Error(`poseAt needs a finite tMs >= 0 (got ${String(tMs)}) — a NaN clock would silently emit NaN transforms`);
  }
  const keys = timeline.keys;
  if (keys.length === 0 || tMs <= keys[0].tMs) {
    const pose = keys.length > 0 ? poseById(rig, keys[0].poseId) : null;
    return { tMs, parts: pose ? resolvePose(rig, pose) : restState(rig) };
  }
  const last = keys[keys.length - 1];
  if (tMs >= last.tMs) {
    return { tMs, parts: resolvePose(rig, poseById(rig, last.poseId)) };
  }
  let hi = 1;
  while (hi < keys.length && keys[hi].tMs < tMs) hi++;
  const fromKey = keys[hi - 1];
  const toKey = keys[hi];
  const from = resolvePose(rig, poseById(rig, fromKey.poseId));
  const to = resolvePose(rig, poseById(rig, toKey.poseId));
  const span = toKey.tMs - fromKey.tMs;
  const u = evalEase(toKey.ease ?? "linear", (tMs - fromKey.tMs) / span);
  const parts: Record<string, RigPartState> = {};
  for (const id of Object.keys(to)) {
    const a = from[id];
    const b = to[id];
    parts[id] = {
      rotateDeg: a.rotateDeg + (b.rotateDeg - a.rotateDeg) * u,
      x: a.x + (b.x - a.x) * u,
      y: a.y + (b.y - a.y) * u,
      scale: a.scale + (b.scale - a.scale) * u,
    };
  }
  return { tMs, parts };
}

// ---------------------------------------------------------------------------
// The beat-sync mouth schedule.
// ---------------------------------------------------------------------------

/** One measured word span in ms — the captions lane's ms space (the
 *  measured rung's spans; seconds × 1000). */
export interface WordSpanMs {
  word: string;
  startMs: number;
  endMs: number;
}

export interface MouthBeat {
  startMs: number;
  endMs: number;
  shape: MouthShape;
}

/** The syllable law — vowel groups (a e i o u y), min 1, cap 4. The count
 *  PACES the open/close beats; it is not a pronunciation claim (the honesty
 *  law: this is beat-sync, not phoneme lip-sync). Deterministic. */
export function countSyllables(word: string): number {
  const letters = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!letters) return 1;
  const groups = letters.match(/[aeiouy]+/g);
  const n = groups ? groups.length : 1;
  return Math.min(4, Math.max(1, n));
}

export const MAX_SYLLABLES_PER_WORD = 4;
/** The named wall: 4 syllables × (open + close) — 8 beats per word. */
export const MAX_BEATS_PER_WORD = 8;

/**
 * buildMouthBeats — the beat-sync schedule from the MEASURED word spans.
 * Each word's span is sliced into 2 × syllables equal slices, alternating
 * open → closed (a syllable is one open beat plus one close beat); the
 * open shape is always "open" (wide/oh/smile are authored pose slots —
 * never invented from text). Gaps between words stay silent: the schedule
 * only carries the measured spans, and mouthAt reads them as closed.
 * Refusals name their reason: an empty stream, a non-ascending span, an
 * overlap — the same monotone law the caption cues ride. Pure.
 */
export function buildMouthBeats(spans: WordSpanMs[]): MouthBeat[] {
  if (!Array.isArray(spans) || spans.length === 0) {
    throw new Error("the mouth schedule needs at least one measured word span");
  }
  let lastEnd = -1;
  const beats: MouthBeat[] = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (
      typeof span.startMs !== "number" ||
      typeof span.endMs !== "number" ||
      !Number.isFinite(span.startMs) ||
      !Number.isFinite(span.endMs) ||
      span.endMs < span.startMs
    ) {
      throw new Error(
        `measured word span ${i} ("${span.word}") is not a finite ascending range (${String(span.startMs)}..${String(span.endMs)}ms)`,
      );
    }
    if (span.startMs < lastEnd) {
      throw new Error(
        `the measured word stream overlaps at span ${i} ("${span.word}") — the mouth schedule rides the same monotone law as the cues`,
      );
    }
    lastEnd = span.endMs;
    const opens = countSyllables(span.word);
    const slices = opens * 2;
    const dur = (span.endMs - span.startMs) / slices;
    for (let k = 0; k < slices; k++) {
      beats.push({
        startMs: span.startMs + dur * k,
        endMs: span.startMs + dur * (k + 1),
        shape: k % 2 === 0 ? "open" : "closed",
      });
    }
  }
  return beats;
}

/**
 * mouthAt — the per-frame read: the shape of the beat holding tMs, or
 * "closed" outside every measured beat (gaps between words are silence —
 * the mouth is honest about it). A NaN clock reads closed: a frame never
 * carries NaN. Deterministic.
 */
export function mouthAt(beats: MouthBeat[], tMs: number): MouthShape {
  if (typeof tMs !== "number" || !Number.isFinite(tMs)) return "closed";
  for (const beat of beats) {
    if (tMs < beat.startMs) break;
    if (tMs < beat.endMs) return beat.shape;
  }
  return "closed";
}

/**
 * The bridge from the measured ASR rung (providers/asr.ts words, SECONDS)
 * onto the schedule's ms space. Rounded to integer ms — the same rounding
 * the voice-anchor path uses, so both consumers of one measured stream
 * agree on the numbers. Pure.
 */
export function wordSpansFromAsr(words: AsrWord[]): WordSpanMs[] {
  return words.map((w) => ({
    word: w.word,
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
  }));
}
