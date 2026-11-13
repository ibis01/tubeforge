// Stage S — the shared animation substrate: keyframes (S120 §8).
//
// Ordered keyframe lists with clamped evaluation and eased tweens — the
// generic shape the G1/K1 `frameAt` implementations consume. Pure: no fs,
// no clock, no randomness; evaluation is a pure function of (keys, tMs).
import { evalEase, type EaseName } from "./easing";

/** One keyframe: a time on the scene clock and the value it holds. The
 *  SEGMENT's easing comes from the DESTINATION keyframe (the ease named
 *  on the key you are arriving at — the convention every consumer shares). */
export interface Keyframe {
  tMs: number;
  value: number;
  ease?: EaseName;
}

/** A structured-value tween hook: interpolate one channel pair at progress
 *  u (0..1). Numeric keyframes use the default linear lerp; consumers with
 *  structured values (colors, poses) supply their own. */
export type LerpFn = (a: number, b: number, u: number) => number;

const numericLerp: LerpFn = (a, b, u) => a + (b - a) * u;

/** Validate once: non-empty, finite times/values, strictly ascending.
 *  Junk input is a CALLER bug (planners clamp their own clocks) — refuse
 *  loudly instead of emitting a frame the reader would have to reject. */
function checkKeys(keys: readonly Keyframe[]): void {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("keyframe list is empty — nothing to evaluate");
  }
  let prev = -Infinity;
  for (const k of keys) {
    if (!Number.isFinite(k.tMs) || !Number.isFinite(k.value)) {
      throw new Error(`keyframe at ${String(k.tMs)}ms carries a non-finite time or value`);
    }
    if (k.tMs <= prev) {
      throw new Error(`keyframes must strictly ascend (${k.tMs}ms after ${String(prev)}ms) — sort them or merge the duplicates`);
    }
    prev = k.tMs;
  }
}

/** evalAt — the clamped evaluation: before the first key → the first
 *  value; after the last → the last value; between → the segment's eased
 *  tween. Pure and deterministic (the S64 law, generalized). */
export function evalAt(keys: readonly Keyframe[], tMs: number, lerp: LerpFn = numericLerp): number {
  checkKeys(keys);
  const t = Number.isFinite(tMs) ? tMs : keys[0].tMs;
  if (t <= keys[0].tMs) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.tMs) return last.value;
  let hi = 1;
  while (hi < keys.length && keys[hi].tMs < t) hi++;
  const from = keys[hi - 1];
  const to = keys[hi];
  const span = to.tMs - from.tMs;
  const u = span > 0 ? (t - from.tMs) / span : 0;
  return lerp(from.value, to.value, evalEase(to.ease ?? "linear", u));
}

/** Tween composition helper: build a keyframe list from (time, value)
 *  pairs with a shared ease — the planner-side sugar so engines never
 *  hand-roll the same array shape. */
export function keyframes(pairs: ReadonlyArray<readonly [number, number]>, ease?: EaseName): Keyframe[] {
  const out = pairs.map(([tMs, value]) => ({ tMs, value, ...(ease ? { ease } : {}) }));
  checkKeys(out);
  return out;
}
