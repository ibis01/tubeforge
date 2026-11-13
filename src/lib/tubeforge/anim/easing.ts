// Stage S — the shared animation substrate: easing (S120 §8).
//
// ONE tiny, pure, engine-neutral motion vocabulary for the NEW engines
// (G1 motion graphics, K1 character rigs) so they never duplicate easing
// math between themselves. The whiteboard's timing.ts is deliberately NOT
// migrated onto this module — its determinism pins make byte-identity the
// priority (S120 §8: "no rewrite of timing.ts onto the new substrate").
//
// Laws: every curve is a PURE function of progress in [0, 1]; every curve
// clamps (progress outside the domain → the boundary value); no fs, no
// clock, no randomness (the S64 law generalizes). easeInOut is the SAME
// cubic family the whiteboard's own scheduler uses — one formula family,
// two consumers, documented.
export type EaseName = "linear" | "ease-in-out" | "ease-out" | "pop" | "ease-back";

const clamp01 = (t: number): number => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0);

/** Constant speed. */
function linear(t: number): number {
  return clamp01(t);
}

/** The whiteboard family's cubic ease-in-out (timing.ts easeInOut — the
 *  same closed form, so a G1/K1 tween and a whiteboard stroke share one
 *  motion feel). */
function easeInOut(t: number): number {
  const u = clamp01(t);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

/** Fast start, gentle settle (cubic out — the same family's exit). */
function easeOut(t: number): number {
  const u = clamp01(t);
  return 1 - Math.pow(1 - u, 3);
}

/** Back-overshoot constants: s1 sets how far past the target the curve
 *  swings before settling; c3 is its cubic coefficient (the standard
 *  easeOutBack closed form). */
const BACK_S1 = 1.70158; // the standard small overshoot (~10%)
const BACK_C3 = BACK_S1 + 1;
const POP_S1 = 2.59481; // a louder swing (~20%) for emphasis pops
const POP_C3 = POP_S1 + 1;

const backWith = (s1: number, c3: number) => (t: number): number => {
  const u = clamp01(t);
  // The clamped boundaries are EXACT by definition — the closed form's
  // floating-point residue (1 − c3 + s1 ≈ 2.2e-16) never leaks through.
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const d = u - 1;
  return 1 + c3 * d * d * d + s1 * d * d;
};

/** Settle with a small overshoot (~10% — the C2-ext "ease-back"). */
const easeBack = backWith(BACK_S1, BACK_C3);

/** Settle with a loud overshoot (~20%) — the emphasis pop. */
const pop = backWith(POP_S1, POP_C3);

/** The table — complete and closed: a new curve is a design-doc slice. */
export const EASE_CURVES: Readonly<Record<EaseName, (t: number) => number>> = Object.freeze({
  linear,
  "ease-in-out": easeInOut,
  "ease-out": easeOut,
  pop,
  "ease-back": easeBack,
});

export function isEaseName(name: string): name is EaseName {
  return Object.prototype.hasOwnProperty.call(EASE_CURVES, name);
}

/** Evaluate a named curve with the clamp law applied (non-finite → 0). */
export function evalEase(name: EaseName, t: number): number {
  const fn = EASE_CURVES[name];
  if (!fn) throw new Error(`unknown easing curve "${name}" — the table is ${Object.keys(EASE_CURVES).join("|")}`);
  return fn(t);
}

// ---------------------------------------------------------------------------
// The zoompan progress-expression compiler — the ffmpeg-expression shapes
// the cinematic lane's motion.ts uses, generalized to the substrate's
// curves. `last` = the expression's frame count (zoompan's `on` runs
// 0..last). smooth/linear reproduce motion.ts progressExpr BYTE-FOR-BYTE
// (the suite pins the literals against motion.ts's own source); the three
// back-overshoot curves compile to closed-form pow() expressions.
// ---------------------------------------------------------------------------

export function zoomProgressExpr(name: EaseName | "smooth", last: number): string {
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`zoomProgressExpr needs a positive frame count, got ${String(last)}`);
  }
  const n = `on/${last}`;
  switch (name) {
    case "linear":
      return `(${n})`;
    case "smooth":
    case "ease-in-out":
      // motion.ts's smooth curve: the cosine ease byte-for-byte.
      return `(0.5-0.5*cos(PI*${n}))`;
    case "ease-out":
      return `(1-pow(1-${n},3))`;
    case "ease-back":
      return `(1+${BACK_C3}*pow(${n}-1,3)+${BACK_S1}*pow(${n}-1,2))`;
    case "pop":
      return `(1+${POP_C3}*pow(${n}-1,3)+${POP_S1}*pow(${n}-1,2))`;
  }
}
