// S89 (ROADMAP #8, S76 §5 P2) — the stock ranker + the multi-frame verdict
// math. PURE module: no I/O, no DB, no network — every rule is pinnable
// offline (scripts/test-unit.mts, "S89" suites).
//
// rankCandidates turns the scene index into an ordered walk list:
//   HARD FLOORS (a candidate is dropped, not down-ranked):
//     • landscape ≥ 1280×720, duration ≥ 2s (the pre-S89 usable filter)
//     • a license label — the index already enforces it; the floor is the
//       second lock (defense in depth: "no unverified footage silently
//       accepted" must not depend on one module's discipline)
//   FACTORS (each 0..1, weighted):
//     • duration fit — a clip that covers the scene needs no loop (dominant)
//     • resolution — absolute sharpness + the ≥1080p step
//     • aspect — closeness to the 16:9 delivery target
//     • semantic — tag overlap with the scene's content words (Pixabay
//       carries tags; Pexels video search does not — the factor is NEUTRAL
//       for tag-less candidates, never a penalty)
//   DUPLICATE POLICY — a clip already placed on another scene of this video
//     (same source:id) is not banned: it takes the fixed DUPLICATE_PENALTY
//     so every fresh candidate outranks it. Duplicated b-roll is a last
//     resort, visible in the factor breakdown — not a silent repeat.
//
// combineFrameVerdicts is the verifier's reducer (see stock-verify.ts):
// multi-frame relevance + the deterministic motion measurement, fail-open
// but RECORDED — pass:true requires ≥2 passing frames by construction.

import type { SceneIndexEntry, StockCandidate } from "./stock-index";
import { clipKey } from "./stock-index";

// ---------- ranking ----------

/** The factor weights (out of 100). Exported for the pins. */
export const RANK_WEIGHTS = {
  durationFit: 40,
  resolution: 20,
  aspect: 10,
  semantic: 30,
} as const;

/** The fixed score subtraction for a clip already used on another scene. */
export const DUPLICATE_PENALTY = 1000;

/** The delivery target every story render composes into. */
const TARGET_ASPECT = 16 / 9;

export interface RankContext {
  /** The scene's spoken duration — the loop-or-not threshold. */
  sceneDurationSec: number;
  /** `source:id` keys already placed on OTHER scenes of this video. */
  usedClipKeys: ReadonlySet<string>;
  /** The scene's content words (visual + narration) — the semantic factor. */
  sceneTerms: string[];
}

export interface RankedCandidate {
  entry: SceneIndexEntry;
  score: number;
  factors: {
    durationFit: number;
    resolution: number;
    aspect: number;
    semantic: number;
    duplicatePenalty: number;
  };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** The hard floors — a candidate that fails any rule is UNUSABLE, not merely weak. */
export function candidateFloors(c: StockCandidate): string | null {
  if (!c.license) return "no license label";
  if (!c.id || !c.url) return "no stable id or download url";
  if (c.width < 1280 || c.height < 720) return "below 720p";
  if (c.width <= c.height) return "portrait";
  if (c.durationSec < 2) return "under 2s";
  return null;
}

function durationFit(c: StockCandidate, sceneDur: number): number {
  if (sceneDur <= 0) return 1;
  return c.durationSec >= sceneDur ? 1 : clamp01(c.durationSec / sceneDur);
}

function resolutionFactor(c: StockCandidate): number {
  // 70% linear sharpness (capped at 4K) + 30% the ≥1080p step.
  return 0.7 * (Math.min(c.width, 3840) / 3840) + 0.3 * (c.width >= 1920 ? 1 : 0);
}

function aspectFactor(c: StockCandidate): number {
  const ratio = c.width / Math.max(c.height, 1);
  return clamp01(1 - Math.abs(ratio - TARGET_ASPECT) / TARGET_ASPECT);
}

/** Tag overlap with the scene's terms; NEUTRAL (0) when the source has no tags. */
export function semanticFactor(c: StockCandidate, terms: string[]): number {
  if (!c.tags || c.tags.length === 0 || terms.length === 0) return 0;
  const wanted = new Set(terms.map((t) => t.toLowerCase()));
  const overlap = c.tags.filter((t) => wanted.has(t.toLowerCase())).length;
  return clamp01(overlap / 3); // 3+ shared terms = full marks
}

/**
 * Rank the index for one scene. Deterministic: score desc, then clip key
 * asc — the same index always produces the same walk order (reproducible
 * runs, pinnable).
 */
export function rankCandidates(
  entries: SceneIndexEntry[],
  ctx: RankContext
): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const entry of entries) {
    const c = entry.candidate;
    if (candidateFloors(c) !== null) continue; // dropped, not down-ranked
    const factors = {
      durationFit: durationFit(c, ctx.sceneDurationSec),
      resolution: resolutionFactor(c),
      aspect: aspectFactor(c),
      semantic: semanticFactor(c, ctx.sceneTerms),
      duplicatePenalty: ctx.usedClipKeys.has(clipKey(c)) ? DUPLICATE_PENALTY : 0,
    };
    const score =
      RANK_WEIGHTS.durationFit * factors.durationFit +
      RANK_WEIGHTS.resolution * factors.resolution +
      RANK_WEIGHTS.aspect * factors.aspect +
      RANK_WEIGHTS.semantic * factors.semantic -
      factors.duplicatePenalty;
    ranked.push({ entry, score, factors });
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score || clipKey(a.entry.candidate).localeCompare(clipKey(b.entry.candidate))
  );
  return ranked;
}

// ---------- multi-frame verdict math ----------

/**
 * A clip whose first/last sampled frames differ by less than this mean luma
 * delta (0-255 scale) is a STILL (a frozen frame in an mp4). B-roll exists
 * to add movement — a still belongs to the Smart Motion art lane, which
 * renders stills natively.
 */
export const MOTION_STATIC_MAX = 1.0;

export interface CombinedVerdict {
  pass: boolean | null;
  reason: string;
  framesSampled: number;
  framesPassed: number;
  framesFailed: number;
}

/**
 * Interior sample times (seconds) for a clip of `durationSec`: evenly spaced
 * fractions k/(n+1) — for 3 frames of a 6s clip: 1.5s / 3s / 4.5s. Interior
 * points dodge opening fades and end cards without needing edge clamps.
 * Degenerate: clips under 1.5s get one mid-frame; zero/negative → none.
 */
export function stockFrameTimes(durationSec: number, frames = 3): number[] {
  if (!(durationSec > 0)) return [];
  if (durationSec < 1.5) return [durationSec / 2];
  const n = Math.max(1, Math.min(frames, 3));
  return Array.from({ length: n }, (_, i) => (durationSec * (i + 1)) / (n + 1));
}

/**
 * Combine the per-frame relevance verdicts + the motion measurement into the
 * accept/reject decision. Rules, in order:
 *   1. STATIC — a measurable near-zero motion delta rejects even relevant
 *      clips (a still is the art lane's job, and wastes a download).
 *   2. ≥2 failing frames — the "grocery market for a market crash" shape,
 *      now requiring the unrelated subject to show up MORE THAN ONCE (a
 *      single odd frame — a title card, a cutaway — no longer rejects).
 *   3. ≥2 passing frames — accepted, verdict "pass".
 *   4. Anything else (mixed 1-0, all-unchecked) — pass:null, "unverified".
 *      Fail-open like the pre-S89 single-frame gate, but RECORDED: the ref
 *      stamps verdict "unverified", never a silent "verified".
 * motionDelta null (measurement failed) is ignored — measurement failure
 * must not reject footage.
 */
export function combineFrameVerdicts(
  verdicts: readonly (boolean | null)[],
  motionDelta: number | null
): CombinedVerdict {
  const framesSampled = verdicts.length;
  const framesPassed = verdicts.filter((v) => v === true).length;
  const framesFailed = verdicts.filter((v) => v === false).length;

  if (motionDelta != null && motionDelta < MOTION_STATIC_MAX)
    return {
      pass: false,
      reason: `static clip — no measurable motion between the sampled frames (delta ${motionDelta.toFixed(2)})`,
      framesSampled,
      framesPassed,
      framesFailed,
    };
  if (framesFailed >= 2)
    return {
      pass: false,
      reason: "unrelated content in multiple sampled frames",
      framesSampled,
      framesPassed,
      framesFailed,
    };
  if (framesPassed >= 2)
    return {
      pass: true,
      reason: "relevant content in multiple sampled frames",
      framesSampled,
      framesPassed,
      framesFailed,
    };
  return {
    pass: null,
    reason: "insufficient frame evidence — kept unverified",
    framesSampled,
    framesPassed,
    framesFailed,
  };
}
