// S93 (ROADMAP #12, P3) — the character rig, v1: a motion SOURCE, not a
// pipeline. The S76 governing rule (§8) and the acceptance row ("Rig,
// motion, continuity, export tests — Reusable engine contract") both land
// the same way: the rig emits MotionScenePlans — the EXISTING zoompan
// engine's own plan vocabulary — for cast-character scenes. Every executor
// downstream (sceneFilterGraph's frame-quantized shot allocation, the QC
// battery, the critic, the timeline contract) is shared, untouched.
//
// THE RIG VOCABULARY (v1 — transforms on identity-locked art, honestly):
// a still portrait cannot blink or lip-sync, and the rig will not fake it.
// What it CAN do — measured, subtle, in-character — is the breath cycle:
// alternating gentle push-in / pull-back on the face band, the way a held
// camera breathes with a seated subject. The pose sheet (S83) and the i2v
// lane (S35) remain the paths to REAL motion; the rig gives cast scenes
// life without either.
//
// THE SENIORITY LADDER (render.ts, unchanged by the rig):
//   Director per-shot plan (M2) > studio motion overrides (Stage 5 D)
//   > studio camera keyframes (S2 wave 2) > THE RIG > the auto plan.
//   The stillness contract is senior to everything: motion off / intensity
//   below the floor → the rig emits a HOLD plan (ambient drift via the
//   existing hold law), never movement.
//
// THE CONTINUITY LAW: the rig applies ONLY to cast scenes (hostInScene on
// a video with a portrait-backed character) — the identity-locked art the
// VCE anchors (S77–S83). Moving an identity anchor's framing risks the
// very drift the VCE judges, so the rig's amplitudes are deliberately
// below the kenburns defaults (RIG_AMP_MAX 3% vs the 12% smart default).

import { pacingSpeedFactor } from "./director-plan";
import type { MotionScenePlan } from "./motion";

/** A breath beat — in/out alternation at the resting breath rate. */
const BREATH_SEC = 2.2; // ~27 breaths/min — calm, cinematic
const RIG_AMP_MAX = 3; // % zoom amplitude — deliberately below kenburns defaults
const RIG_AMP_MIN = 1;
/** The face band of portrait-framed art: upper-center, where the head sits. */
export const RIG_HEAD_FOCAL = { x: 0.5, y: 0.35 } as const;

export interface RigInput {
  sceneIndex: number;
  durationSec: number;
  /** The video's motion intensity (0..30, motion.ts vocabulary). */
  intensity: number;
  /** The video's motion mode — "off" triggers the stillness contract. */
  motionMode: string;
  /** The scene's narration pacing hint (the approved plan's), if any —
   *  a "fast" hint breathes slightly quicker, "slow" slightly deeper. */
  pacingHint?: string;
}

/**
 * The rig's MotionScenePlan for ONE cast scene. Deterministic: the same
 * inputs always produce the same plan (the zoompan executor fits the beats
 * to the frame count — the shot allocation stays the shared, pinned clock).
 */
export function rigPlan(opts: RigInput): MotionScenePlan {
  // THE STILLNESS CONTRACT — senior to the rig: no mode, no motion.
  if (opts.motionMode === "off" || opts.intensity < 1) {
    return {
      sceneType: "emotional",
      move: "Rig hold (stillness contract)",
      shots: [{ kind: "hold", zStart: 1, zEnd: 1, focal: { ...RIG_HEAD_FOCAL }, travel: 0, sec: BREATH_SEC }],
      staticImage: false,
    };
  }

  // The pacing hint modulates the breath rate (module E's ±12% factor —
  // pacing is direction, applied to the breath as to the read).
  const factor = pacingSpeedFactor(opts.pacingHint ?? "normal");
  const beat = BREATH_SEC / factor;

  // The amplitude scale: the rig runs at ~25% of the video's motion
  // intensity, clamped to its own band — a whisper, never a punch.
  const amp = Math.max(RIG_AMP_MIN, Math.min(opts.intensity * 0.25, RIG_AMP_MAX));

  // The beat count: enough in/out pairs to cover the scene (≥1 pair).
  const beats = Math.max(2, Math.floor(opts.durationSec / beat) + ((opts.durationSec / beat) % 1 > 0.15 ? 1 : 0));
  const shots = Array.from({ length: beats }, (_, i) => {
    // In on even beats, out on odd — the breath cycle. The zoompan executor
    // linearly interpolates each shot between its z endpoints, so the
    // alternation reads as a continuous breathe.
    const kind = i % 2 === 0 ? ("zoom-in" as const) : ("zoom-out" as const);
    const z = 1 + (amp / 100);
    return {
      kind,
      zStart: i % 2 === 0 ? 1 : z,
      zEnd: i % 2 === 0 ? z : 1,
      focal: { ...RIG_HEAD_FOCAL },
      travel: 0,
      sec: beat,
    };
  });

  return {
    sceneType: "emotional", // cast scenes classify emotional (hostInScene law)
    move: "Rig breath cycle",
    shots,
    staticImage: false,
  };
}

/** The rig's eligibility — exported so the route/UI reads ONE law. */
export function rigEligible(
  video: { characterId: string | null },
  character: { hasPortrait: boolean } | null,
  sceneHostInScene: boolean
): boolean {
  return Boolean(video.characterId) && Boolean(character?.hasPortrait) && sceneHostInScene;
}
