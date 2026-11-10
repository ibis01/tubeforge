// S77 — Visual Consistency Engine (Phase A).
//
// docs/design/s77-visual-consistency.md is the contract; the laws below
// cite its sections. The engine UNIFIES the judges that already existed —
// the identity continuity pass (director.ts) and the per-image quality
// gate — behind ONE report envelope on Video.consistency, and adds the
// dimension nobody had: cross-scene STYLE cohesion. It proposes repairs;
// it never regenerates anything (§0.2).
//
//   runConsistencyEngine   the job body: identity (reused verbatim) +
//                          style batches (new) + the deterministic style
//                          contract + repair proposals + history ledger.
//
// Everything with a fork in it that a test can pin lives in the pure
// section: verdict math (min-across / worst-of / honest zero), the style
// contract, batch chunking, the strict-JSON reply parser, the proposal
// builder, the history cap. The VLM layers fail OPEN — an unavailable
// dimension is recorded as "unavailable" with the error text, never as a
// passing score (§0.3).

import { db } from "./tenant-db";
import { assertCtx } from "./tenant";
import { aiCall } from "./budget";
import { llmVision } from "./llm";
import { parseJsonLoose } from "./ai";
import { parseScenes, sceneImageFile } from "./story";
import { parsePlan } from "./director-plan";
import { runContinuityCheck, type ContinuityReport, type SceneConsistency } from "./director";
import { errorText } from "./redact";
import * as storage from "./storage";
import { log } from "./log";

const vcLog = log.child({ mod: "visual-consistency" });

// ---------------------------------------------------------------------------
// Types — the V2 envelope (§3). V1 ContinuityReport fields keep their names,
// shapes and semantics; everything else is additive.

export type ConsistencyDimension = "identity" | "style";
export type DimVerdict = "consistent" | "drift" | "off" | "unavailable";

export interface DimensionScore {
  score: number | null; // null = not checked (no cast art, batch failure, …)
  verdict: DimVerdict;
  issues: string[];
}

export interface SceneConsistencyV2 {
  sceneIndex: number;
  score: number | null; // min across checked dimensions — the binding constraint
  verdict: DimVerdict; // worst across checked dimensions
  issues: string[]; // identity issues then style issues
  dims: {
    identity?: DimensionScore;
    style?: DimensionScore;
  };
}

export interface StyleContract {
  styles: string[]; // distinct scene style ids, first-seen order
  majority: string; // the mode (ties → first-seen)
  outliers: number[]; // scene indexes whose configured style ≠ majority
  colorGrade: string | null; // approved plan's first-shot grade
}

export interface RepairProposal {
  sceneIndex: number;
  dimension: ConsistencyDimension;
  instruction: string;
}

export interface HistoryEntry {
  at: string;
  overall: number;
  triggered: string;
}

export interface ConsistencyReportV2 {
  schema: 2;
  checkedAt: string;
  overall: number; // mean of checked dimension scores; 0 = nothing checked (V1 parity)
  checkedCount: number; // how many dimensions actually returned a score
  scenes: SceneConsistencyV2[];
  styleContract: StyleContract;
  proposals: RepairProposal[];
  history: HistoryEntry[]; // bounded, newest last
  engine: { identity: boolean; style: boolean; unavailable: string[] };
}

// ---------------------------------------------------------------------------
// Pure verdict math (§2) — pinned.

export function verdictFromScore(score: number): Exclude<DimVerdict, "unavailable"> {
  if (score >= 80) return "consistent";
  if (score >= 55) return "drift";
  return "off";
}

const VERDICT_RANK: Record<"off" | "drift" | "consistent", number> = {
  off: 0,
  drift: 1,
  consistent: 2,
};

/** The worst of two CHECKED verdicts. "unavailable" never wins — an
 *  unchecked dimension must not drag a judged scene down with it (§2). */
export function worstVerdict(
  a: Exclude<DimVerdict, "unavailable">,
  b: Exclude<DimVerdict, "unavailable">
): Exclude<DimVerdict, "unavailable"> {
  return VERDICT_RANK[a] <= VERDICT_RANK[b] ? a : b;
}

/** Scene score = MIN across checked, non-unavailable dimensions; null when
 *  nothing was checked. */
export function sceneScoreOf(
  dims: { identity?: DimensionScore; style?: DimensionScore }
): number | null {
  const checked = [dims.identity, dims.style].filter(
    (d): d is DimensionScore => d !== undefined && d.score !== null && d.verdict !== "unavailable"
  );
  if (checked.length === 0) return null;
  return Math.min(...checked.map((d) => d.score as number));
}

/** Scene verdict = WORST checked dimension; "unavailable" only when every
 *  dimension is unchecked/unavailable. */
export function sceneVerdictOf(
  dims: { identity?: DimensionScore; style?: DimensionScore }
): DimVerdict {
  const checked = [dims.identity, dims.style].filter(
    (d): d is DimensionScore => d !== undefined && d.score !== null && d.verdict !== "unavailable"
  );
  if (checked.length === 0) return "unavailable";
  return checked.reduce(
    (worst, d) => worstVerdict(worst, d.verdict as Exclude<DimVerdict, "unavailable">),
    "consistent" as Exclude<DimVerdict, "unavailable">
  );
}

/** Overall = rounded mean of EVERY checked dimension score across scenes;
 *  checkedCount is the honest-zero probe; 0 only when nothing was checked
 *  (V1 parity — the card renders a number). */
export function overallScoreOf(scenes: SceneConsistencyV2[]): {
  overall: number;
  checkedCount: number;
} {
  const scores: number[] = [];
  for (const scene of scenes) {
    for (const dim of [scene.dims.identity, scene.dims.style]) {
      if (dim && dim.score !== null && dim.verdict !== "unavailable") scores.push(dim.score);
    }
  }
  if (scores.length === 0) return { overall: 0, checkedCount: 0 };
  return {
    overall: Math.round(scores.reduce((a, c) => a + c, 0) / scores.length),
    checkedCount: scores.length,
  };
}

// ---------------------------------------------------------------------------
// The deterministic style contract (§4) — zero AI, pinned.

export interface StyleEntry {
  sceneIndex: number;
  style: string | null | undefined; // null/undefined = the "default" pipeline look
}

/** The video's own style contract from CONFIG (Scene.style ids + the
 *  approved plan's color grade). Descriptive, not enforceable — §0.5. */
export function deriveStyleContract(
  entries: StyleEntry[],
  colorGrade: string | null | undefined
): StyleContract {
  const normalized = entries.map((e) => ({
    sceneIndex: e.sceneIndex,
    style: typeof e.style === "string" && e.style.trim() ? e.style.trim() : "default",
  }));

  const styles: string[] = [];
  const counts = new Map<string, number>();
  for (const { style } of normalized) {
    if (!counts.has(style)) {
      styles.push(style);
      counts.set(style, 0);
    }
    counts.set(style, (counts.get(style) ?? 0) + 1);
  }

  let majority = "";
  let majorityCount = -1;
  for (const style of styles) {
    const count = counts.get(style) ?? 0;
    if (count > majorityCount) {
      majority = style;
      majorityCount = count;
    }
  }

  return {
    styles,
    majority,
    outliers: normalized
      .filter((e) => e.style !== majority)
      .map((e) => e.sceneIndex),
    colorGrade:
      typeof colorGrade === "string" && colorGrade.trim() ? colorGrade.trim() : null,
  };
}

/** The approved plan's first-shot color grade — mirrors
 *  directorImageAddendum's read (`first.colorGrade`); "" / unapproved → null. */
export function approvedColorGrade(
  directorState: string | null | undefined,
  planJson: string | null | undefined
): string | null {
  if (directorState !== "approved") return null;
  const plan = parsePlan(planJson);
  const first = plan?.scenes.find((s) => s.sceneIndex === 1)?.shots[0];
  return first?.colorGrade?.trim() ? first.colorGrade.trim() : null;
}

// ---------------------------------------------------------------------------
// Style VLM plumbing (§5) — batching + the strict-JSON reply parser, pinned.

export const STYLE_SYSTEM = `You are a style-cohesion judge for a video's storyboard. You see several generated scene images from the SAME video, in story order. Judge ONLY visual style cohesion across them: colour palette, rendering technique and medium, lighting language, level of realism versus stylization, line quality and grain or texture. Ignore subject matter, framing, composition and any characters — identity is judged elsewhere.

Respond with STRICT JSON only: {"scores":{"<sceneIndex>":<0-100>},"issues":{"<sceneIndex>":["<short human-readable issue>"]}} — score 100 means the image sits perfectly inside the video's established look; list concrete style deviations per scene (empty arrays when none). Every labelled scene index MUST appear in your reply.`;

/** Chunk scene indexes into VLM batches, story order kept. */
export function buildStyleBatches(indexes: number[], max = 6): number[][] {
  const size = Math.max(1, Math.floor(max));
  const batches: number[][] = [];
  for (let i = 0; i < indexes.length; i += size) batches.push(indexes.slice(i, i + size));
  return batches;
}

/**
 * Parse one batch reply into per-scene dimensions. JSON keys are STRINGS
 * (JSON has no numeric keys) — pinned. A scene the reply skipped is
 * "unavailable" ("no verdict returned"), never a fail; a malformed reply
 * returns null and the caller marks the whole batch unavailable (§0.3).
 */
export function parseStyleVerdicts(
  text: string,
  batchIndexes: number[]
): Map<number, DimensionScore> | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonLoose(text);
  } catch {
    return null;
  }
  const scores = parsed.scores;
  const issues = parsed.issues;
  if (!scores || typeof scores !== "object") return null;

  const scoreMap = scores as Record<string, unknown>;
  const issueMap =
    issues && typeof issues === "object" ? (issues as Record<string, unknown>) : {};

  const result = new Map<number, DimensionScore>();
  for (const index of batchIndexes) {
    const raw = scoreMap[String(index)];
    const scoreNum = Number(raw);
    const score = Number.isFinite(scoreNum)
      ? Math.round(Math.min(100, Math.max(0, scoreNum)))
      : null;
    const rawIssues = issueMap[String(index)];
    const sceneIssues = Array.isArray(rawIssues)
      ? rawIssues.filter((i): i is string => typeof i === "string").slice(0, 6)
      : [];
    result.set(
      index,
      score === null
        ? { score: null, verdict: "unavailable", issues: ["no verdict returned"] }
        : { score, verdict: verdictFromScore(score), issues: sceneIssues }
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Repair proposals (§6) — propose, never auto-edit (§0.2). Pinned.

export function buildRepairProposals(
  scenes: SceneConsistencyV2[],
  contract: StyleContract,
  cap = 8
): RepairProposal[] {
  const proposals: RepairProposal[] = [];
  for (const scene of scenes) {
    if (scene.verdict !== "drift" && scene.verdict !== "off") continue;
    const identity = scene.dims.identity;
    if (identity && identity.score !== null && identity.verdict !== "consistent" && identity.issues[0]) {
      proposals.push({
        sceneIndex: scene.sceneIndex,
        dimension: "identity",
        instruction: identity.issues[0],
      });
    }
    const style = scene.dims.style;
    if (style && style.score !== null && style.verdict !== "consistent" && style.issues[0]) {
      proposals.push({
        sceneIndex: scene.sceneIndex,
        dimension: "style",
        instruction: `Repaint this scene to match the video's dominant look${
          contract.majority ? ` (${contract.majority})` : ""
        }: ${style.issues[0]}. Keep the composition and subject.`,
      });
    }
    if (proposals.length >= cap) break;
  }
  return proposals.slice(0, cap);
}

// ---------------------------------------------------------------------------
// History ledger (§3) — bounded, newest last. Pinned.

export function pushHistory(
  history: HistoryEntry[],
  entry: HistoryEntry,
  cap = 12
): HistoryEntry[] {
  return [...history, entry].slice(-cap);
}

/** Parse the persisted report — V2 rows round-trip; legacy V1 rows
 *  (identity-only, no schema field) normalize with EMPTY additive fields
 *  (never fabricated ones). Returns null for null/corrupt/non-report JSON. */
export function parseConsistencyReport(json: string | null | undefined): ConsistencyReportV2 | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).scenes)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schema === 2) {
    const checkedAt = typeof obj.checkedAt === "string" ? obj.checkedAt : new Date(0).toISOString();
    const overall = Number(obj.overall);
    const checkedCount = Number(obj.checkedCount);
    const history = Array.isArray(obj.history) ? (obj.history as HistoryEntry[]) : [];
    const scenes = (obj.scenes as Record<string, unknown>[]).map((s) => {
      const dims = (s.dims ?? {}) as { identity?: DimensionScore; style?: DimensionScore };
      return {
        sceneIndex: Number(s.sceneIndex),
        score: s.score === null || s.score === undefined ? null : Number(s.score),
        verdict: (s.verdict ?? "unavailable") as DimVerdict,
        issues: Array.isArray(s.issues) ? (s.issues as string[]) : [],
        dims,
      };
    });
    return {
      schema: 2,
      checkedAt,
      overall: Number.isFinite(overall) ? overall : 0,
      checkedCount: Number.isFinite(checkedCount) ? checkedCount : 0,
      scenes,
      styleContract: (obj.styleContract as StyleContract) ?? {
        styles: [],
        majority: "",
        outliers: [],
        colorGrade: null,
      },
      proposals: Array.isArray(obj.proposals) ? (obj.proposals as RepairProposal[]) : [],
      history: history.filter((h) => h && typeof h === "object" && typeof h.at === "string"),
      engine: (obj.engine as ConsistencyReportV2["engine"]) ?? {
        identity: false,
        style: false,
        unavailable: [],
      },
    };
  }

  // Legacy V1 — identity-only ContinuityReport. Map into the V2 shape with
  // EMPTY additive fields; the identity dimension IS the V1 scene verdict.
  const scenes: SceneConsistencyV2[] = (obj.scenes as Record<string, unknown>[]).map((s) => {
    const score = s.score === null || s.score === undefined ? null : Number(s.score);
    const verdict = (s.verdict ?? "unavailable") as DimVerdict;
    const issues = Array.isArray(s.issues) ? (s.issues as string[]) : [];
    return {
      sceneIndex: Number(s.sceneIndex),
      score,
      verdict,
      issues,
      dims:
        score === null
          ? {}
          : { identity: { score, verdict: verdict as DimVerdict, issues } },
    };
  });
  const overall = Number(obj.overall);
  return {
    schema: 2,
    checkedAt: typeof obj.checkedAt === "string" ? obj.checkedAt : new Date(0).toISOString(),
    overall: Number.isFinite(overall) ? overall : 0,
    checkedCount: scenes.filter((s) => s.score !== null).length,
    scenes,
    styleContract: { styles: [], majority: "", outliers: [], colorGrade: null },
    proposals: [],
    history: [],
    engine: { identity: true, style: false, unavailable: [] },
  };
}

// ---------------------------------------------------------------------------
// The VLM style pass — batched, fail-open (§5).

async function runStylePass(videoId: string, sceneIndexes: number[]): Promise<{
  byIndex: Map<number, DimensionScore>;
  unavailable: string[];
}> {
  const byIndex = new Map<number, DimensionScore>();
  const unavailable: string[] = [];

  for (const batch of buildStyleBatches(sceneIndexes, 6)) {
    // Read the painted art; a scene whose bytes vanished between the stat
    // and the read drops out of THIS batch and is reported unavailable.
    const parts: unknown[] = [
      { type: "text", text: "Generated storyboard scenes of ONE video, in story order:" },
    ];
    const batchPresent: number[] = [];
    for (const index of batch) {
      const buf = await storage
        .get(`${videoId}/${sceneImageFile(index)}`)
        .catch(() => null);
      if (!buf) {
        byIndex.set(index, {
          score: null,
          verdict: "unavailable",
          issues: ["scene art unreadable at check time"],
        });
        continue;
      }
      batchPresent.push(index);
      parts.push({ type: "text", text: `Scene ${index}:` });
      parts.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${buf.toString("base64")}` },
      });
    }

    // Cohesion is a COMPARISON — a single image has nothing to drift from.
    if (batchPresent.length < 2) {
      for (const index of batchPresent) {
        byIndex.set(index, {
          score: null,
          verdict: "unavailable",
          issues: ["style cohesion needs at least two painted scenes in a batch"],
        });
      }
      continue;
    }

    try {
      const raw = await aiCall("llm", "consistency style VLM", () =>
        llmVision({
          messages: [
            { role: "system", content: STYLE_SYSTEM },
            { role: "user", content: parts },
          ],
          temperature: 0.1,
        })
      );
      const text = raw.choices?.[0]?.message?.content ?? "";
      const parsed = parseStyleVerdicts(text, batchPresent);
      if (!parsed) {
        unavailable.push(`style batch [${batch.join(",")}]: unparseable reply`);
        for (const index of batchPresent) {
          byIndex.set(index, {
            score: null,
            verdict: "unavailable",
            issues: ["style judge reply was malformed"],
          });
        }
        continue;
      }
      for (const [index, dim] of parsed) byIndex.set(index, dim);
    } catch (err) {
      unavailable.push(`style batch [${batch.join(",")}]: ${errorText(err, "vision error").slice(0, 120)}`);
      for (const index of batchPresent) {
        byIndex.set(index, {
          score: null,
          verdict: "unavailable",
          issues: [`style check failed: ${errorText(err, "vision error").slice(0, 120)}`],
        });
      }
    }
  }

  return { byIndex, unavailable };
}

// ---------------------------------------------------------------------------
// The engine — the "consistency" job body. Runs under ctx (assertCtx), like
// every job body.

export async function runConsistencyEngine(
  videoId: string,
  opts: { triggered?: string } = {}
): Promise<ConsistencyReportV2> {
  const ctx = assertCtx("runConsistencyEngine");
  const triggered = opts.triggered ?? "manual";

  const video = await db.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      organizationId: true,
      scenes: true,
      shotList: true,
      directorState: true,
      consistency: true,
    },
  });
  if (!video) throw new Error("Video not found");
  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0) throw new Error("No scenes to check");

  // Read the PRIOR report's history BEFORE the identity pass runs —
  // runContinuityCheck overwrites the column with a legacy V1 report, and
  // the ledger must survive the round trip (§3).
  const priorHistory =
    parseConsistencyReport(video.consistency)?.history ?? [];

  // 1. Identity — the EXISTING pass, reused verbatim (its own Activity row
  //    and column write stand; the engine lifts its per-scene verdicts).
  const identityByIndex = new Map<number, SceneConsistency>();
  const engineUnavailable: string[] = [];
  let identityRan = false;
  try {
    const identityReport: ContinuityReport = await runContinuityCheck(videoId);
    identityRan = true;
    for (const scene of identityReport.scenes) identityByIndex.set(scene.sceneIndex, scene);
    if (identityReport.scenes.length === 0)
      engineUnavailable.push("identity: no cast scenes with painted art to check");
  } catch (err) {
    engineUnavailable.push(`identity: ${errorText(err, "continuity check failed").slice(0, 120)}`);
  }

  // 2. Painted art — the style pass only judges scenes that exist on disk.
  const painted: number[] = [];
  for (const scene of scenes) {
    const stat = await storage
      .stat(`${videoId}/${sceneImageFile(scene.index)}`)
      .catch(() => null);
    if (stat) painted.push(scene.index);
  }

  // 3. The deterministic style contract from config (zero AI).
  const contract = deriveStyleContract(
    scenes.map((s) => ({ sceneIndex: s.index, style: s.style })),
    approvedColorGrade(video.directorState, video.shotList)
  );

  // 4. The VLM style pass — batches of 6, cohesion needs ≥2 images.
  let styleByIndex = new Map<number, DimensionScore>();
  let styleRan = false;
  if (painted.length >= 2) {
    const style = await runStylePass(videoId, painted);
    styleByIndex = style.byIndex;
    styleRan = true;
    engineUnavailable.push(...style.unavailable);
  } else {
    for (const index of painted) {
      styleByIndex.set(index, {
        score: null,
        verdict: "unavailable",
        issues: ["style cohesion needs at least two painted scenes"],
      });
    }
    if (painted.length < 2)
      engineUnavailable.push("style: fewer than two painted scenes — nothing to compare");
  }

  // 5. Config outliers join the style dimension as ISSUES (visibility
  //    without a fake score — the operator chose that style card).
  for (const index of contract.outliers) {
    const dim = styleByIndex.get(index);
    const note = `configured style "${scenes.find((s) => s.index === index)?.style ?? "default"}" differs from the video's majority ("${contract.majority}")`;
    if (dim) styleByIndex.set(index, { ...dim, issues: [note, ...dim.issues].slice(0, 6) });
    else styleByIndex.set(index, { score: null, verdict: "unavailable", issues: [note] });
  }

  // 6. Unify — one row per scene the engine actually looked at.
  const v2Scenes: SceneConsistencyV2[] = scenes
    .filter((s) => identityByIndex.has(s.index) || styleByIndex.has(s.index))
    .map((s) => {
      const identity = identityByIndex.get(s.index);
      const style = styleByIndex.get(s.index);
      const dims: SceneConsistencyV2["dims"] = {};
      if (identity)
        dims.identity = { score: identity.score, verdict: identity.verdict, issues: identity.issues };
      if (style) dims.style = style;
      return {
        sceneIndex: s.index,
        score: sceneScoreOf(dims),
        verdict: sceneVerdictOf(dims),
        issues: [...(identity?.issues ?? []), ...(style?.issues ?? [])],
        dims,
      };
    })
    .sort((a, b) => a.sceneIndex - b.sceneIndex);

  const { overall, checkedCount } = overallScoreOf(v2Scenes);

  const report: ConsistencyReportV2 = {
    schema: 2,
    checkedAt: new Date().toISOString(),
    overall,
    checkedCount,
    scenes: v2Scenes,
    styleContract: contract,
    proposals: buildRepairProposals(v2Scenes, contract),
    history: pushHistory(priorHistory, { at: new Date().toISOString(), overall, triggered }),
    engine: { identity: identityRan, style: styleRan, unavailable: engineUnavailable },
  };

  await db.video.update({
    where: { id: videoId },
    data: { consistency: JSON.stringify(report), error: null },
  });
  await db.activity.create({
    data: {
      organizationId: video.organizationId,
      userId: ctx.userId,
      videoId,
      stage: "consistency",
      message: `Consistency check (${triggered}): ${overall}% overall, ${checkedCount} dimension score(s) across ${v2Scenes.length} scene(s)`,
    },
  });
  vcLog.info("consistency report written", { videoId, overall, checkedCount, triggered });
  return report;
}
