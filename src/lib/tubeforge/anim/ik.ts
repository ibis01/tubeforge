// anim/ik — two-bone planar inverse kinematics: shoulder at the origin,
// elbow placed by the cosine law, hand exactly on the target.
//
// Provenance: these are algorithms worth having from the "Stickman Video
// Director" project (MIT-licensed source, audited 2026-11-14),
// REIMPLEMENTED independently in TypeScript (no code copied). This is
// S121 P2 of the unified integration roadmap — the shared Stage-X motion
// primitives the graphics/character lanes build on.
//
// Laws. S64 purity: every function is PURE — no fs, no clock, no
// randomness, no globals; same inputs → same outputs, always.
// Refuse-not-clamp: an unreachable or collapsed target is REFUSED with a
// named reason — the solver never silently clamps a target onto the reach
// boundary, because a clamped solve lies about where the hand landed.
// Pole continuity: the elbow's solution side comes from the pole vector's
// side of the shoulder→target line (the cross product's sign) — for a
// moving target the bend flips ONLY when the pole crosses that line,
// never per-call randomness; a pole riding the line deterministically
// keeps the counter-clockwise side. The hand lands EXACTLY on the target,
// so every solve round-trips with fkTwoBone.

/** A two-bone chain: the upper and fore segment lengths (both > 0). */
export interface TwoBoneChain {
  upper: number;
  fore: number;
}

/** A planar (XY) chain pose: the elbow joint and the hand, with the
 *  shoulder fixed at the origin. */
export interface TwoBonePose {
  elbow: { x: number; y: number };
  hand: { x: number; y: number };
}

/** The degeneracy epsilon: a target this close to the shoulder has no
 *  defined elbow direction, and no real pose lives inside it. */
const EPS = 1e-9;

/** Shared chain check: finite, positive lengths, with the refusing
 *  caller named in the message (solve vs fk). */
function checkChain(chain: TwoBoneChain, who: string): void {
  if (!Number.isFinite(chain.upper) || !Number.isFinite(chain.fore) || chain.upper <= 0 || chain.fore <= 0) {
    throw new Error(
      `${who}: the chain lengths must be finite and positive, got upper=${String(chain.upper)} fore=${String(chain.fore)}`,
    );
  }
}

/** Solve the two-bone chain so the hand lands EXACTLY on `target`, with
 *  the elbow bending toward `pole`. Refuses (never clamps) when:
 *  - the chain lengths are non-finite or <= 0;
 *  - the target or pole is non-finite;
 *  - the target distance exceeds the total reach (unreachable);
 *  - the target sits on the shoulder (degenerate — no elbow direction);
 *  - the target distance fails the triangle inequality |upper − fore| < d
 *    (fully-folded degeneracy — the triangle collapses onto the bone).
 *
 *  Construction (the standard cosine-law solve): d = |target|;
 *  a = (upper² − fore² + d²) / (2d) is the elbow's projection onto the
 *  shoulder→target axis; h = √(upper² − a²) lifts the elbow off that
 *  axis. At the exact reach boundary floating-point residue can push a²
 *  a hair past upper², so the radicand is clamped at 0 — a last-ulp
 *  guard, not a silent clamp of the input. The side comes from the pole
 *  (see the pole-continuity law above); hand = target, exactly. */
export function solveTwoBone(
  chain: TwoBoneChain,
  target: { x: number; y: number },
  pole: { x: number; y: number },
): TwoBonePose {
  checkChain(chain, "ik solve refused");
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new Error(`ik solve refused: the target is not finite (${String(target.x)}, ${String(target.y)})`);
  }
  if (!Number.isFinite(pole.x) || !Number.isFinite(pole.y)) {
    throw new Error(`ik solve refused: the pole is not finite (${String(pole.x)}, ${String(pole.y)})`);
  }
  const { upper, fore } = chain;
  const d = Math.hypot(target.x, target.y);
  const reach = upper + fore;
  if (d > reach) {
    throw new Error(
      `ik solve refused: unreachable — target distance ${d} exceeds the chain's total reach ${reach}`,
    );
  }
  if (d < EPS) {
    throw new Error(
      `ik solve refused: degenerate — the target sits on the shoulder (distance ${d} < ${EPS}), so the elbow direction is undefined`,
    );
  }
  const fold = Math.abs(upper - fore);
  if (d <= fold) {
    throw new Error(
      `ik solve refused: fully-folded degeneracy — target distance ${d} does not clear |upper − fore| = ${fold}, the triangle collapses onto the bone`,
    );
  }
  const a = (upper * upper - fore * fore + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, upper * upper - a * a));
  const ux = target.x / d;
  const uy = target.y / d;
  // Pole side: the sign of (shoulder→target) × (shoulder→pole). Positive
  // → the pole is on the counter-clockwise side and the elbow bends to
  // meet it there; negative → the clockwise side; zero → the pole rides
  // the line and the choice deterministically defaults to the CCW side
  // (a documented tie-break, never random — a pole sliding ALONG the line
  // never flips the solution).
  const cross = target.x * pole.y - target.y * pole.x;
  const side = cross >= 0 ? 1 : -1;
  // The CCW perpendicular of u = (ux, uy) is (−uy, ux); `side` picks it
  // or its mirror.
  const elbow = {
    x: a * ux - side * h * uy,
    y: a * uy + side * h * ux,
  };
  return { elbow, hand: { x: target.x, y: target.y } };
}

/** Forward kinematics: rotate `upper` by shoulderAngle from the +X axis,
 *  then `fore` by (shoulderAngle + elbowAngle); hand = elbow + fore
 *  vector. Refuses non-finite angles and bad chains — fk is the
 *  round-trip partner of solveTwoBone and must never emit NaN poses. */
export function fkTwoBone(chain: TwoBoneChain, shoulderAngle: number, elbowAngle: number): TwoBonePose {
  checkChain(chain, "ik fk refused");
  if (!Number.isFinite(shoulderAngle) || !Number.isFinite(elbowAngle)) {
    throw new Error(
      `ik fk refused: the angles must be finite, got shoulder=${String(shoulderAngle)} elbow=${String(elbowAngle)}`,
    );
  }
  const elbow = {
    x: chain.upper * Math.cos(shoulderAngle),
    y: chain.upper * Math.sin(shoulderAngle),
  };
  const hand = {
    x: elbow.x + chain.fore * Math.cos(shoulderAngle + elbowAngle),
    y: elbow.y + chain.fore * Math.sin(shoulderAngle + elbowAngle),
  };
  return { elbow, hand };
}

/** Cheap geometric pre-check (pure, never throws): true when the chain
 *  and target are finite and the target distance sits inside the solvable
 *  band |upper − fore| ≤ d ≤ upper + fore (a small tolerance absorbs the
 *  last ulp at both edges). solveTwoBone remains the authority — it
 *  additionally refuses the on-shoulder and fully-folded degeneracies
 *  that this band check alone allows. */
export function isReachable(chain: TwoBoneChain, target: { x: number; y: number }): boolean {
  if (!Number.isFinite(chain.upper) || !Number.isFinite(chain.fore) || chain.upper <= 0 || chain.fore <= 0) {
    return false;
  }
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    return false;
  }
  const d = Math.hypot(target.x, target.y);
  const tol = 1e-9;
  return d >= Math.abs(chain.upper - chain.fore) - tol && d <= chain.upper + chain.fore + tol;
}
