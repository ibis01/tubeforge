// S77 — Visual Consistency Engine (Phase A; S78 — Phase B slice 1, the
// dedicated appearance dimension).
//
// docs/design/s77-visual-consistency.md is the contract; the laws below
// cite its sections. The engine UNIFIES the judges that already existed —
// the identity continuity pass (director.ts) and the per-image quality
// gate — behind ONE report envelope on Video.consistency, and adds the
// dimensions nobody had: cross-scene STYLE cohesion, and (S78) the
// APPEARANCE pass judging the cast's logged costume/accessory look from
// the approved plan's CharacterAppearance rows. It proposes repairs;
// it never regenerates anything (§0.2).
//
//   runConsistencyEngine   the job body: identity (reused verbatim) +
//                          appearance (S78, one call per logged-look
//                          scene) + style batches + the deterministic
//                          style contract + repair proposals + history
//                          ledger.
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

export type ConsistencyDimension = "identity" | "appearance" | "style";
export type DimVerdict = "consistent" | "drift" | "off" | "unavailable";

export interface DimensionScore {
  score: number | null; // null = not checked (no cast art, batch failure, …)
  verdict: DimVerdict;
  issues: string[];
}

/** The per-dimension truth of ONE scene, keyed by dimension id. Issue
 *  joins and math iterate in this order: identity, appearance, style. */
export type SceneDims = {
  identity?: DimensionScore;
  appearance?: DimensionScore;
  style?: DimensionScore;
};

const DIMENSION_KEYS = ["identity", "appearance", "style"] as const;

export interface SceneConsistencyV2 {
  sceneIndex: number;
  score: number | null; // min across checked dimensions — the binding constraint
  verdict: DimVerdict; // worst across checked dimensions
  issues: string[]; // identity issues, then appearance, then style
  dims: SceneDims;
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
  engine: { identity: boolean; appearance: boolean; style: boolean; unavailable: string[] };
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
export function sceneScoreOf(dims: SceneDims): number | null {
  const checked = DIMENSION_KEYS.map((k) => dims[k]).filter(
    (d): d is DimensionScore => d !== undefined && d.score !== null && d.verdict !== "unavailable"
  );
  if (checked.length === 0) return null;
  return Math.min(...checked.map((d) => d.score as number));
}

/** Scene verdict = WORST checked dimension; "unavailable" only when every
 *  dimension is unchecked/unavailable. */
export function sceneVerdictOf(dims: SceneDims): DimVerdict {
  const checked = DIMENSION_KEYS.map((k) => dims[k]).filter(
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
    for (const key of DIMENSION_KEYS) {
      const dim = scene.dims[key];
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
// Appearance plumbing (S78, §5b) — the logged-look gates + the per-scene
// reply parser, pinned.

/** One approved plan's logged look for a scene — the CharacterAppearance
 *  row's editable half. null/undefined/whitespace = not logged. */
export interface AppearanceEntry {
  sceneIndex: number;
  outfit: string | null | undefined;
  accessory: string | null | undefined;
}

/** The look clause the appearance pass judges against — MIRRORS
 *  getApprovedAppearanceClause's composition exactly (outfit, accessory
 *  ", "-joined, trimmed): the judge scores the look the pipeline
 *  actually paints, never a fantasy of it. */
export function buildAppearanceLook(
  row: Pick<AppearanceEntry, "outfit" | "accessory">
): string {
  return [row.outfit, row.accessory]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join(", ");
}

/**
 * Which scenes get an appearance check: the plan APPROVED, the scene
 * carries cast, and a look is actually logged. Zero AI, zero storage —
 * the caller supplies host indexes and the DB rows.
 */
export function buildAppearanceTargets(
  rows: AppearanceEntry[],
  hostIndexes: number[],
  planApproved: boolean
): number[] {
  if (!planApproved) return [];
  const hosts = new Set(hostIndexes);
  const byScene = new Map<number, AppearanceEntry>();
  for (const row of rows) if (!byScene.has(row.sceneIndex)) byScene.set(row.sceneIndex, row);
  const targets: number[] = [];
  for (const [index, row] of byScene) {
    if (hosts.has(index) && buildAppearanceLook(row) !== "") targets.push(index);
  }
  return targets.sort((a, b) => a - b);
}

export const APPEARANCE_SYSTEM = `You are an appearance-continuity judge for a video's storyboard. You see ONE generated scene image of a recurring character together with the look logged for that scene in the production plan. Judge ONLY appearance continuity: the depicted clothing and accessories versus the logged outfit and accessory (garment type, colour, layering, worn props). Ignore face, hair, age and build — identity is judged elsewhere. Ignore art style, lighting, framing and background — style is judged elsewhere.

Respond with STRICT JSON only: {"score":<0-100>,"issues":["<short human-readable issue>"]} — score 100 means the depicted costume and props match the logged look; list concrete mismatches (empty array when none).`;

/**
 * Parse one appearance reply. Same strictness family as the style parser,
 * but the continuity reply shape: a missing/garbage score is NULL — the
 * caller records "unavailable". It is NEVER defaulted (the legacy pass's
 * silent 50 was a fabricated number; §0.3 forbids that here).
 */
export function parseAppearanceVerdict(text: string): DimensionScore | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonLoose(text);
  } catch {
    return null;
  }
  const scoreNum = Number(parsed.score);
  if (!Number.isFinite(scoreNum)) return null;
  const score = Math.round(Math.min(100, Math.max(0, scoreNum)));
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.filter((i): i is string => typeof i === "string").slice(0, 6)
    : [];
  return { score, verdict: verdictFromScore(score), issues };
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
    const appearance = scene.dims.appearance;
    if (appearance && appearance.score !== null && appearance.verdict !== "consistent" && appearance.issues[0]) {
      proposals.push({
        sceneIndex: scene.sceneIndex,
        dimension: "appearance",
        instruction: `Redress this scene to match the logged look: ${appearance.issues[0]}. Keep the pose, face and framing.`,
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

// ---------------------------------------------------------------------------
// Targeted re-check (S79, §7b) — ONE scene after a repaint, merged into
// the prior report. Pinned pure parts: the neighbour batch and the merge.

/**
 * The targeted STYLE batch: the repainted scene plus its nearest painted
 * neighbours — scene order kept, capped at max. Cohesion needs ≥2 images
 * (§5), so a lone scene is judged "unavailable" by the style pass, never
 * a fabricated pass. Nearest-first with distance tie-break to the lower
 * index: deterministic, no batch-composition roulette.
 */
export function buildTargetBatch(painted: number[], target: number, max = 6): number[] {
  const size = Math.max(2, Math.floor(max));
  const others = [...new Set(painted)].filter((i) => i !== target);
  const picked = others
    .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)
    .slice(0, size - 1);
  return [target, ...picked].sort((a, b) => a - b);
}

/** Replace-or-insert ONE scene row into the report's scene list, scene
 *  order kept — the targeted re-check's ONLY write surface: every other
 *  scene's last full-check verdict stands untouched. */
export function mergeTargetedRow(
  scenes: SceneConsistencyV2[],
  row: SceneConsistencyV2
): SceneConsistencyV2[] {
  const next = scenes.filter((s) => s.sceneIndex !== row.sceneIndex);
  next.push(row);
  return next.sort((a, b) => a.sceneIndex - b.sceneIndex);
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
      const dims = (s.dims ?? {}) as SceneDims;
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
        appearance: false,
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
    engine: { identity: true, appearance: false, style: false, unavailable: [] },
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
// The VLM appearance pass (S78, §5b) — one call per logged-look scene,
// fail-open (§0.3).

async function runAppearancePass(
  videoId: string,
  targets: { sceneIndex: number; look: string }[]
): Promise<{ byIndex: Map<number, DimensionScore>; unavailable: string[] }> {
  const byIndex = new Map<number, DimensionScore>();
  const unavailable: string[] = [];

  for (const target of targets) {
    // An unpainted scene has nothing to judge — no dimension row at all
    // (the identity pass's own convention), never a fabricated fail.
    const buf = await storage
      .get(`${videoId}/${sceneImageFile(target.sceneIndex)}`)
      .catch(() => null);
    if (!buf) continue;

    try {
      const raw = await aiCall("llm", "consistency appearance VLM", () =>
        llmVision({
          messages: [
            { role: "system", content: APPEARANCE_SYSTEM },
            {
              role: "user",
              content: [
                { type: "text", text: `Logged look for this scene: ${target.look}` },
                { type: "text", text: `Scene ${target.sceneIndex} generated image follows.` },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${buf.toString("base64")}` },
                },
              ],
            },
          ],
          temperature: 0.1,
        })
      );
      const text = raw.choices?.[0]?.message?.content ?? "";
      const parsed = parseAppearanceVerdict(text);
      byIndex.set(
        target.sceneIndex,
        parsed ?? {
          score: null,
          verdict: "unavailable",
          issues: ["appearance judge reply was malformed"],
        }
      );
      if (!parsed) unavailable.push(`appearance scene ${target.sceneIndex}: unparseable reply`);
    } catch (err) {
      unavailable.push(
        `appearance scene ${target.sceneIndex}: ${errorText(err, "vision error").slice(0, 120)}`
      );
      byIndex.set(target.sceneIndex, {
        score: null,
        verdict: "unavailable",
        issues: [`appearance check failed: ${errorText(err, "vision error").slice(0, 120)}`],
      });
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
      characterId: true,
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

  // 5. The appearance pass (S78) — the approved plan's logged looks, one
  //    VLM call per target scene (approved + cast + a look actually logged).
  const hostIndexes = scenes.filter((s) => s.hostInScene).map((s) => s.index);
  const planApproved = video.directorState === "approved";
  const appearanceRows: AppearanceEntry[] = video.characterId
    ? await db.characterAppearance.findMany({
        where: { videoId, characterId: video.characterId },
        select: { sceneIndex: true, outfit: true, accessory: true },
      })
    : [];
  const appearanceTargets = buildAppearanceTargets(appearanceRows, hostIndexes, planApproved);
  let appearanceByIndex = new Map<number, DimensionScore>();
  let appearanceRan = false;
  if (appearanceTargets.length > 0) {
    const targets = appearanceTargets.map((index) => {
      const row = appearanceRows.find((r) => r.sceneIndex === index);
      return { sceneIndex: index, look: row ? buildAppearanceLook(row) : "" };
    });
    const appearance = await runAppearancePass(videoId, targets);
    appearanceByIndex = appearance.byIndex;
    appearanceRan = true;
    engineUnavailable.push(...appearance.unavailable);
  } else if (planApproved && video.characterId && hostIndexes.length > 0) {
    engineUnavailable.push("appearance: approved plan has no logged looks to judge");
  }

  // 6. Config outliers join the style dimension as ISSUES (visibility
  //    without a fake score — the operator chose that style card).
  for (const index of contract.outliers) {
    const dim = styleByIndex.get(index);
    const note = `configured style "${scenes.find((s) => s.index === index)?.style ?? "default"}" differs from the video's majority ("${contract.majority}")`;
    if (dim) styleByIndex.set(index, { ...dim, issues: [note, ...dim.issues].slice(0, 6) });
    else styleByIndex.set(index, { score: null, verdict: "unavailable", issues: [note] });
  }

  // 7. Unify — one row per scene the engine actually looked at.
  const v2Scenes: SceneConsistencyV2[] = scenes
    .filter(
      (s) =>
        identityByIndex.has(s.index) || appearanceByIndex.has(s.index) || styleByIndex.has(s.index)
    )
    .map((s) => {
      const identity = identityByIndex.get(s.index);
      const appearance = appearanceByIndex.get(s.index);
      const style = styleByIndex.get(s.index);
      const dims: SceneConsistencyV2["dims"] = {};
      if (identity)
        dims.identity = { score: identity.score, verdict: identity.verdict, issues: identity.issues };
      if (appearance) dims.appearance = appearance;
      if (style) dims.style = style;
      return {
        sceneIndex: s.index,
        score: sceneScoreOf(dims),
        verdict: sceneVerdictOf(dims),
        issues: [
          ...(identity?.issues ?? []),
          ...(appearance?.issues ?? []),
          ...(style?.issues ?? []),
        ],
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
    engine: {
      identity: identityRan,
      appearance: appearanceRan,
      style: styleRan,
      unavailable: engineUnavailable,
    },
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

// ---------------------------------------------------------------------------
// The targeted re-check (S79, §7b) — ONE scene after a repaint, merged
// into the prior report. A repaint changes the art; every verdict that
// judged the OLD art is obsolete for that scene. The full pass re-judges
// every host scene (double VLM spend for repainters — §7 chose not to);
// this re-judges ONLY the repainted scene: identity (dry), appearance
// (if a look is logged), and style against its nearest painted
// neighbours. Propose-never-auto-edit, fail-open, aiCall-metered — the
// same laws as the full engine.

export async function runTargetedRecheck(
  videoId: string,
  sceneIndex: number,
  opts: { triggered?: string } = {}
): Promise<ConsistencyReportV2> {
  const ctx = assertCtx("runTargetedRecheck");
  const triggered = opts.triggered ?? "repaint";

  const video = await db.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      organizationId: true,
      characterId: true,
      scenes: true,
      shotList: true,
      directorState: true,
      consistency: true,
    },
  });
  if (!video) throw new Error("Video not found");
  const scenes = parseScenes(video.scenes);
  const scene = scenes.find((s) => s.index === sceneIndex);
  if (!scene) throw new Error(`Scene ${sceneIndex} does not exist`);

  // No prior V2 report — there is nothing to merge into. The full engine
  // is the honest path (it will also write the first report).
  const prior = parseConsistencyReport(video.consistency);
  if (!prior || prior.schema !== 2)
    return runConsistencyEngine(videoId, { triggered });

  const unavailable: string[] = [];

  // Painted art — the style batch only judges scenes that exist on disk.
  const painted: number[] = [];
  for (const s of scenes) {
    const stat = await storage
      .stat(`${videoId}/${sceneImageFile(s.index)}`)
      .catch(() => null);
    if (stat) painted.push(s.index);
  }

  // 1. Identity — the existing pass scoped to ONE scene, DRY (no column
  //    write, no Activity row of its own). A thrown check REPLACES the
  //    stale verdict with "unavailable" — the old number judged art that
  //    no longer exists; it must not stand as current truth.
  let identityDim: DimensionScore | undefined;
  let identityRan = false;
  try {
    const report = await runContinuityCheck(videoId, { onlyScene: sceneIndex });
    const row = report.scenes.find((s) => s.sceneIndex === sceneIndex);
    if (row) {
      identityDim = { score: row.score, verdict: row.verdict, issues: row.issues };
      identityRan = true;
    }
  } catch (err) {
    const why = errorText(err, "continuity check failed").slice(0, 120);
    unavailable.push(`identity scene ${sceneIndex}: ${why}`);
    identityDim = { score: null, verdict: "unavailable", issues: [`identity check failed: ${why}`] };
  }

  // 2. Appearance — the same gates as the full pass, scoped to this scene.
  let appearanceDim: DimensionScore | undefined;
  let appearanceRan = false;
  if (video.characterId) {
    const rows: AppearanceEntry[] = await db.characterAppearance.findMany({
      where: { videoId, characterId: video.characterId, sceneIndex },
      select: { sceneIndex: true, outfit: true, accessory: true },
    });
    const hostIndexes = scene.hostInScene ? [sceneIndex] : [];
    const targets = buildAppearanceTargets(rows, hostIndexes, video.directorState === "approved");
    if (targets.length > 0) {
      const look = buildAppearanceLook(rows[0] ?? { sceneIndex, outfit: null, accessory: null });
      const pass = await runAppearancePass(videoId, [{ sceneIndex, look }]);
      const dim = pass.byIndex.get(sceneIndex);
      if (dim) {
        appearanceDim = dim;
        appearanceRan = true;
      }
      unavailable.push(...pass.unavailable);
    }
  }

  // 3. Style — the repainted scene against its nearest painted neighbours.
  //    Only the TARGET's row updates: style scores are batch-relative, and
  //    re-scoring the neighbours under a different batch composition would
  //    churn rows the repaint never touched.
  let styleDim: DimensionScore | undefined;
  let styleRan = false;
  const batch = buildTargetBatch(painted, sceneIndex);
  if (batch.length >= 2) {
    const pass = await runStylePass(videoId, batch);
    const dim = pass.byIndex.get(sceneIndex);
    if (dim) {
      styleDim = dim;
      styleRan = true;
    }
    unavailable.push(...pass.unavailable);
  } else if (painted.includes(sceneIndex)) {
    styleDim = {
      score: null,
      verdict: "unavailable",
      issues: ["style cohesion needs at least two painted scenes"],
    };
  }

  // 4. Merge — one row rebuilt, every other scene's last full-check
  //    verdict stands untouched.
  const priorRow = prior.scenes.find((s) => s.sceneIndex === sceneIndex);
  const dims: SceneDims = { ...(priorRow?.dims ?? {}) };
  if (identityDim) dims.identity = identityDim;
  if (appearanceDim) dims.appearance = appearanceDim;
  if (styleDim) dims.style = styleDim;
  const mergedRow: SceneConsistencyV2 = {
    sceneIndex,
    score: sceneScoreOf(dims),
    verdict: sceneVerdictOf(dims),
    issues: DIMENSION_KEYS.flatMap((k) => dims[k]?.issues ?? []),
    dims,
  };
  const mergedScenes = mergeTargetedRow(prior.scenes, mergedRow);
  const { overall, checkedCount } = overallScoreOf(mergedScenes);

  // The style contract is config — a repaint changes no style card, but
  // the plan may have been approved since the last full run. Zero AI.
  const contract = deriveStyleContract(
    scenes.map((s) => ({ sceneIndex: s.index, style: s.style })),
    approvedColorGrade(video.directorState, video.shotList)
  );

  const report: ConsistencyReportV2 = {
    schema: 2,
    checkedAt: new Date().toISOString(),
    overall,
    checkedCount,
    scenes: mergedScenes,
    styleContract: contract,
    proposals: buildRepairProposals(mergedScenes, contract),
    history: pushHistory(prior.history, { at: new Date().toISOString(), overall, triggered }),
    engine: {
      identity: prior.engine.identity || identityRan,
      appearance: prior.engine.appearance || appearanceRan,
      style: prior.engine.style || styleRan,
      unavailable: [...new Set([...prior.engine.unavailable, ...unavailable])].slice(-12),
    },
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
      message: `Targeted re-check (${triggered}): scene ${sceneIndex} — ${overall}% overall, ${checkedCount} dimension score(s)`,
    },
  });
  vcLog.info("targeted recheck written", { videoId, sceneIndex, overall, triggered });
  return report;
}
