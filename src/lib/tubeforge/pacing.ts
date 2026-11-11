// S92 (ROADMAP #11, S76: "Audio → Improve intelligence") — narration pacing,
// measured not guessed.
//
// The pacing TARGETS have always existed (SCENE_COUNTS "tuned for retention
// pacing", the Director plan's per-scene pacing hints → pacingSpeedFactor
// 0.88/1.0/1.12, the video-level ttsSpeed) — but nothing ever MEASURED the
// delivered pace. This module is the deterministic measurement layer: the
// real per-scene WAV durations against the real narration word counts give
// the true words-per-minute, the bands judge it, and the proposals speak
// the system's own vocabulary (the plan's slow/normal/fast hints + the
// projected WPM each hint would deliver).
//
// Bands are ENGLISH-narration calibrated (the product's TTS voices and the
// retention tuning are English-first); a CJK narration at the same "wpm"
// reads differently — recorded, not silently mis-banded: countWords treats
// CJK text by character so the report stays proportional.
//
// Pure module: no I/O, no DB — the route measures, this judges.

import { pacingSpeedFactor } from "./director-plan";

// ---------- the bands ----------

/** Delivered words-per-minute bands (English narration, measured). */
export const WPM_BANDS = {
  draggingUnder: 130, // < 130 drags — viewers bail
  measuredMax: 175, // 130–175 measured — the body target
  briskMax: 205, // 175–205 brisk — the hook target
  // > 205 rushed — articulation and comprehension fall apart
} as const;

export type PacingBand = "dragging" | "measured" | "brisk" | "rushed" | "unmeasured";

/** The center-of-band target per scene ROLE (words/min). */
export const ROLE_TARGETS = {
  hook: 185, // hooks earn attention by being brisk
  body: 155, // the comprehension sweet spot
  close: 150, // land the ending measured
} as const;

export type SceneRole = keyof typeof ROLE_TARGETS;

/**
 * The scene's role in the retention shape: scene 1 and every re-hook scene
 * are hooks (they exist to re-grab attention); the last scene is the close;
 * everything else is body.
 */
export function sceneRole(index: number, total: number, rehook: boolean): SceneRole {
  if (index === 1 || rehook) return "hook";
  if (total > 1 && index === total) return "close";
  return "body";
}

// ---------- the measurement ----------

/**
 * Words for pacing: whitespace tokens for English; CJK characters count
 * individually (one hanzi ≈ one word-equivalent) so the ratio stays honest.
 */
export function countWords(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) ?? []).length;
  const rest = text
    .replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + rest;
}

/** Delivered words-per-minute; null when the duration is unusable. */
export function sceneWpm(narration: string, durationSec: number | null): number | null {
  if (durationSec == null || !(durationSec > 0.2)) return null;
  const words = countWords(narration);
  if (words < 3) return null; // too little speech to measure a pace
  return (words / durationSec) * 60;
}

export function bandOf(wpm: number | null): PacingBand {
  if (wpm == null) return "unmeasured";
  if (wpm < WPM_BANDS.draggingUnder) return "dragging";
  if (wpm <= WPM_BANDS.measuredMax) return "measured";
  if (wpm <= WPM_BANDS.briskMax) return "brisk";
  return "rushed";
}

// ---------- the proposal (the system's own vocabulary) ----------

export type PacingHint = "slow" | "normal" | "fast";

/**
 * The hint that moves the scene toward its role target, plus what it would
 * deliver. The factor maps to TTS speed (pacingSpeedFactor), so projected
 * WPM = current × factor. "normal" when already in-band — never churn a
 * scene that measures fine.
 */
export function pacingProposal(
  wpm: number | null,
  role: SceneRole
): { verdict: PacingBand; hint: PacingHint; projectedWpm: number | null } {
  if (wpm == null) return { verdict: "unmeasured", hint: "normal", projectedWpm: null };
  const target = ROLE_TARGETS[role];
  const factor = target / wpm; // the exact multiplier that would hit center
  const hint: PacingHint = factor > 1.05 ? "fast" : factor < 0.95 ? "slow" : "normal";
  return {
    verdict: bandOf(wpm),
    hint,
    projectedWpm: Math.round(wpm * pacingSpeedFactor(hint) * 10) / 10,
  };
}

// ---------- the report ----------

export interface PacingSceneRow {
  index: number;
  role: SceneRole;
  words: number;
  durationSec: number | null;
  wpm: number | null;
  band: PacingBand;
  hint: PacingHint;
  projectedWpm: number | null;
}

export interface PacingSummary {
  measured: number;
  unmeasured: number;
  medianWpm: number | null;
  inBand: number; // measured scenes whose band fits their role's intent
  toSpeedUp: number; // dragging scenes
  toSlowDown: number; // rushed scenes
}

export interface PacingReport {
  perScene: PacingSceneRow[];
  summary: PacingSummary;
}

/** A band fits the role's intent: hooks WANT brisk, body/close want measured. */
function bandFitsRole(band: PacingBand, role: SceneRole): boolean {
  if (band === "measured") return true;
  if (role === "hook") return band === "brisk";
  return false; // dragging/rushed never fit; brisk only fits the hook
}

const median = (nums: number[]): number | null => {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * The full report: per-scene measurement + proposal, and the summary a
 * creator reads first ("median 142 wpm · 2 scenes drag · 1 rushes").
 */
export function pacingReport(
  scenes: { index: number; narration: string; rehook: boolean }[],
  durations: (number | null)[]
): PacingReport {
  const total = scenes.length;
  const perScene: PacingSceneRow[] = scenes.map((s, i) => {
    const role = sceneRole(s.index, total, s.rehook);
    const wpm = sceneWpm(s.narration, durations[i] ?? null);
    const p = pacingProposal(wpm, role);
    return {
      index: s.index,
      role,
      words: countWords(s.narration),
      durationSec: durations[i] ?? null,
      wpm,
      band: p.verdict,
      hint: p.hint,
      projectedWpm: p.projectedWpm,
    };
  });

  const measured = perScene.filter((r) => r.wpm != null);
  const summary: PacingSummary = {
    measured: measured.length,
    unmeasured: perScene.length - measured.length,
    medianWpm: median(measured.map((r) => r.wpm as number)),
    inBand: perScene.filter((r) => r.wpm != null && bandFitsRole(r.band, r.role)).length,
    toSpeedUp: perScene.filter((r) => r.band === "dragging").length,
    toSlowDown: perScene.filter((r) => r.band === "rushed").length,
  };
  return { perScene, summary };
}
