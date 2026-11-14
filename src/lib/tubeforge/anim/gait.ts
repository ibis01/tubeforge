// anim/gait — the gait phase model: a walk measured in world distance.
//
// Provenance: these are algorithms worth having from the "Stickman Video
// Director" project (MIT-licensed source, audited 2026-11-14),
// REIMPLEMENTED independently in TypeScript (no code copied). This is
// S121 P2 of the unified integration roadmap — the shared Stage-X motion
// primitives the graphics/character lanes build on.
//
// THE LAW (name it): the phase rides WORLD DISTANCE — never the camera
// and never the wall clock alone. The phase is the distance the body has
// covered measured in strides: a stationary body stands in phase even as
// time passes, and camera motion changes nothing. The tempting
// `worldDistance / strideLength + cadence * timeSec` is WRONG — it makes
// the legs sprint while the body stands still. gaitPhaseAt keeps timeSec
// in its signature (call sites carry the clock) but the law refuses it:
// only the body's own motion — the distance covered — advances the phase.
//
// The 60/40 split: a wrapped phase in [0, 1) spends [0, 0.6) in stance
// (foot planted) and [0.6, 1) in swing (foot lifted on a sine arc) — the
// classic walk-cycle rhythm. S64 purity: every function is PURE — no fs,
// no clock, no randomness, no globals; negative phases wrap by proper
// modulo (never a negative fraction); junk numbers are refused with
// named reasons, never laundered into NaN.

export const STRIDE_PHASES = ["stance", "swing"] as const;
export type StridePhase = (typeof STRIDE_PHASES)[number];

/** Gait tuning: strideLength is world meters per full stride, cadence is
 *  strides per second. Both must be finite and > 0 (validateGaitParams). */
export interface GaitParams {
  strideLength: number;
  cadence: number;
}

/** The stance fraction of a stride: [0, 0.6) planted, [0.6, 1) swinging. */
const STANCE_FRACTION = 0.6;

/** Refuse junk gait params by name: strideLength and cadence must both
 *  be finite and > 0 — a zero or negative stride would divide by zero
 *  (NaN poison) and a non-positive cadence describes no walk at all. */
export function validateGaitParams(params: GaitParams): void {
  if (!Number.isFinite(params.strideLength) || params.strideLength <= 0) {
    throw new Error(
      `gait refused: strideLength must be a finite positive number of world meters per stride, got ${String(params.strideLength)}`,
    );
  }
  if (!Number.isFinite(params.cadence) || params.cadence <= 0) {
    throw new Error(
      `gait refused: cadence must be a finite positive number of strides per second, got ${String(params.cadence)}`,
    );
  }
}

/** THE PHASE-RIDES-DISTANCE LAW: the phase is the distance the body has
 *  covered measured in strides — a stationary body stands in phase even
 *  as time passes, and camera motion changes nothing. phase =
 *  worldDistance / strideLength, advanced ONLY by the body's own motion;
 *  timeSec rides in the signature (call sites carry the clock) but the
 *  law refuses it — time enters only through the distance covered, so
 *  adding cadence · timeSec here would make the legs sprint while the
 *  body stands still. Pure, deterministic; junk inputs are refused. */
export function gaitPhaseAt(params: GaitParams, worldDistance: number, timeSec: number): number {
  validateGaitParams(params);
  if (!Number.isFinite(worldDistance)) {
    throw new Error(`gait refused: worldDistance must be finite, got ${String(worldDistance)}`);
  }
  if (!Number.isFinite(timeSec)) {
    throw new Error(
      "gait refused: timeSec must be finite — it rides in the signature but the phase-rides-distance law refuses to let the clock move the phase",
    );
  }
  return worldDistance / params.strideLength;
}

/** Proper modulo wrap into [0, 1) — a negative phase is a stride walked
 *  backwards, not a negative fraction, so it wraps forward and the output
 *  is never negative. Non-finite phases are refused (never laundered). */
function wrap01(phase: number): number {
  if (!Number.isFinite(phase)) {
    throw new Error(`gait refused: the stride phase must be finite, got ${String(phase)}`);
  }
  return phase - Math.floor(phase);
}

/** Which half of the stride the wrapped phase sits in: stance for
 *  phase mod 1 in [0, 0.6) (the foot planted), swing for [0.6, 1) (the
 *  foot in the air) — the 60/40 stance/swing split. */
export function stridePhaseAt(phase: number): StridePhase {
  const wrapped = wrap01(phase);
  return wrapped < STANCE_FRACTION ? "stance" : "swing";
}

/** The foot's position for one stride cycle, in stride fractions: x is
 *  the linear advance across the cycle (0 → 1 over the wrapped phase) and
 *  y is the lift. During stance the foot is planted — y is EXACTLY 0 and
 *  x advances linearly across the stance band; during swing the foot
 *  lifts on the sine arc — y = stepHeight · sin(π · swingProgress) (zero
 *  at both band edges, so the arc lands the foot smoothly) and x advances
 *  linearly across the swing band. The phase is wrapped first; a bad
 *  stepHeight (non-finite or <= 0) is refused by name. Deterministic. */
export function footArcAt(phase: number, stepHeight: number): { x: number; y: number } {
  if (!Number.isFinite(stepHeight) || stepHeight <= 0) {
    throw new Error(
      `gait refused: stepHeight must be a finite positive lift in world meters, got ${String(stepHeight)}`,
    );
  }
  const wrapped = wrap01(phase);
  if (wrapped < STANCE_FRACTION) {
    return { x: wrapped, y: 0 };
  }
  const swingProgress = (wrapped - STANCE_FRACTION) / (1 - STANCE_FRACTION);
  return { x: wrapped, y: stepHeight * Math.sin(Math.PI * swingProgress) };
}
