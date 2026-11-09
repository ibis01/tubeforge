// S72 — Creator Intelligence CI-4: Retention Intelligence.
//
// From the decision record (docs/audits/creator-intelligence-record.md §3):
// retention ingestion (the YouTube Analytics API — a NEW OAuth scope) with
// drop-off moments mapped to scenes, narration text and pacing via the
// timeline, recommendations attached to the video row.
//
// PROPSES, NEVER AUTO-EDITS — the "AI suggests + human approves" doctrine
// extends to performance data: a revision proposal shows its evidence (the
// cliff, the scene, the words on screen) and waits. Every finding is
// labeled a heuristic; missing data is asked for, never invented.
//
// Layering: the ANALYSIS half is PURE (the curve + a timeline projection
// in, findings out — unit-pinned); the INGESTION half rides youtube.ts's
// OAuth client (fetchRetentionCurve) through the same timeout matrix, and
// the route stores the report as a JSON doc column on the video row (the
// house doc-column law — the eighth).
import type { Scene } from "./types";
import { assembleTimeline } from "./timeline";

// ---------------------------------------------------------------------------
// The pure analysis
// ---------------------------------------------------------------------------

export interface RetentionPoint {
  /** Elapsed video time as a ratio of total duration (0..1). */
  tRatio: number;
  /** Fraction of the audience still watching at tRatio (0..1). */
  watchRatio: number;
}

export interface RetentionDrop {
  atSec: number;
  tRatio: number;
  /** Audience before → after the cliff (watch ratios). */
  from: number;
  to: number;
  /** Lost share of the REMAINING audience — the honest severity unit. */
  magnitude: number;
  sceneIndex: number | null;
  sceneTitle: string | null;
  /** The words on screen at the cliff (evidence, not a vibe). */
  narrationExcerpt: string;
  atSceneBoundary: boolean;
  suggestion: string;
}

export interface RetentionFindings {
  /** Mean watchRatio across the curve — the video's overall hold. */
  averageWatchRatio: number;
  drops: RetentionDrop[];
  heuristic: true;
}

/** A cliff is RELATIVE to the curve's own decay: the median per-point
 *  loss of remaining audience sets the baseline, and a cliff must lose at
 *  least RETENTION_DROP_MEDIAN_MULTIPLE × that baseline (never below the
 *  FLOOR). A steadily-decaying curve — even a steep one — has no localized
 *  cliff, and a flat curve flags a sudden 5%+ snap. This is the honest
 *  detector: it cannot mistake normal attrition for a finding. */
export const RETENTION_DROP_MEDIAN_MULTIPLE = 2;
export const RETENTION_DROP_FLOOR = 0.05;
export const RETENTION_MAX_FINDINGS = 5;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The scene active at a second, from the SAME projection the assemble
 *  route builds (assembleTimeline — the timeline is a projection, the
 *  render is the truth; the findings cite the projection honestly). */
function sceneAtSec(
  scenes: Scene[],
  wavDurations: Record<number, number> | null,
  atSec: number
): { index: number; title: string; narration: string; startSec: number; endSec: number } | null {
  const timeline = assembleTimeline(scenes, { wavDurations: wavDurations ?? undefined });
  for (const t of timeline.scenes) {
    if (atSec >= t.startSec && atSec < t.startSec + t.durationSec) {
      return { index: t.index, title: t.title, narration: t.narration, startSec: t.startSec, endSec: t.endSec };
    }
  }
  return null;
}

/** Detect the cliffs and map them onto the timeline. PURE. `videoDurationSec`
 *  is the published master's duration (the curve's tRatio denominator). */
export function analyzeRetentionCurve(
  points: RetentionPoint[],
  videoDurationSec: number,
  scenes: Scene[] = [],
  wavDurations: Record<number, number> | null = null
): RetentionFindings {
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.tRatio) && Number.isFinite(p.watchRatio))
    .sort((a, b) => a.tRatio - b.tRatio);

  const averageWatchRatio =
    sorted.length > 0 ? sorted.reduce((a, p) => a + p.watchRatio, 0) / sorted.length : 0;

  // First pass: the per-point losses of the REMAINING audience, then the
  // curve's own median decay — the baseline a cliff must stand out from.
  const losses: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.watchRatio <= 0) continue;
    losses.push((prev.watchRatio - cur.watchRatio) / prev.watchRatio);
  }
  const baseline = median(losses);
  const cliffWall = Math.max(RETENTION_DROP_MEDIAN_MULTIPLE * baseline, RETENTION_DROP_FLOOR);

  const drops: RetentionDrop[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.watchRatio <= 0) continue;
    const magnitude = (prev.watchRatio - cur.watchRatio) / prev.watchRatio; // share of the REMAINING audience
    if (magnitude < cliffWall) continue;

    const atSec = Math.max(0, Math.min(videoDurationSec, cur.tRatio * videoDurationSec));
    const active = scenes.length > 0 ? sceneAtSec(scenes, wavDurations, atSec) : null;
    const atSceneBoundary = active ? atSec - active.startSec < 1.5 : false;
    const excerpt = active ? active.narration.replace(/\s+/g, " ").trim().slice(0, 110) : "";

    let suggestion: string;
    if (!active) {
      suggestion =
        scenes.length > 0
          ? `A cliff at ${atSec.toFixed(0)}s — the timeline projection could not resolve a scene at that moment (check the render vs the doc).`
          : `A cliff at ${atSec.toFixed(0)}s — classic-script videos map drops to the script; consider tightening the passage around that timestamp.`;
    } else if (atSceneBoundary) {
      suggestion = `Scene ${active.index} opens with a cliff — the first line may not re-earn attention. Consider tightening the opener or adding a rehook beat.`;
    } else {
      suggestion = `Viewers leave mid-scene ${active.index} (${(atSec - active.startSec).toFixed(0)}s in) — pacing may sag here. Consider shortening the segment or introducing a visual change.`;
    }
    if (magnitude >= 0.2) {
      suggestion += ` A hard cliff: ${Math.round(magnitude * 100)}% of the remaining audience left at once.`;
    }

    drops.push({
      atSec,
      tRatio: cur.tRatio,
      from: prev.watchRatio,
      to: cur.watchRatio,
      magnitude,
      sceneIndex: active?.index ?? null,
      sceneTitle: active?.title ?? null,
      narrationExcerpt: excerpt,
      atSceneBoundary,
      suggestion,
    });
  }

  drops.sort((a, b) => b.magnitude - a.magnitude);
  return {
    averageWatchRatio,
    drops: drops.slice(0, RETENTION_MAX_FINDINGS).sort((a, b) => a.atSec - b.atSec),
    heuristic: true,
  };
}

// ---------------------------------------------------------------------------
// The report (the doc column's shape) + tolerant parse
// ---------------------------------------------------------------------------

export interface RetentionReport {
  youtubeId: string;
  fetchedAt: string;
  videoDurationSec: number;
  points: RetentionPoint[];
  averageWatchRatio: number;
  drops: RetentionDrop[];
  heuristic: true;
}

/** Tolerant parse of the doc column (the parseScenes discipline: null on
 *  invalid, never throw on untrusted JSON). */
export function parseRetentionReport(json: string | null | undefined): RetentionReport | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof raw.youtubeId !== "string" ||
      !Array.isArray(raw.points) ||
      !Array.isArray(raw.drops)
    ) {
      return null;
    }
    return {
      youtubeId: raw.youtubeId,
      fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : new Date(0).toISOString(),
      videoDurationSec: Number(raw.videoDurationSec) || 0,
      points: raw.points as RetentionPoint[],
      averageWatchRatio: Number(raw.averageWatchRatio) || 0,
      drops: raw.drops as RetentionDrop[],
      heuristic: true,
    };
  } catch {
    return null;
  }
}
