// S84 — the Video Critic (foundation). docs/audits/
// s76-openmontage-adoption-decision.md §4.B is the design target:
// the critic inspects the RENDERED video, not just scene stills —
// frame sampling + the existing deterministic QC battery + the stored
// Visual Consistency report + ONE fail-open VLM judgement of narrative
// and visual quality → a structured quality report → repair proposals
// → the human approves → selective regeneration through the EXISTING
// affordances.
//
// Laws (the S77 family, inherited):
//   §0.2 propose, never auto-edit — the critic reports and proposes;
//        nothing regenerates without the human's one-click.
//   §0.3 fail open, never invent — an unavailable layer is recorded
//        "unavailable" with the reason, never a passing score. AI
//        evaluation never REPLACES the deterministic checks (S76's
//        critical rule): technical/motion/audio rows come from the
//        battery, the consistency row from the VCE report, and only
//        the narrative/visual judgement is new AI.
//   §0.4 shared contracts — the one VLM call rides aiCall; frames are
//        sampled through visual-qc's sampler; the report persists via
//        the storage seam; execution runs under the job registry
//        (kind "critic").
//
// The SHIP GATE stays where it is (qc-policy on the QC battery) — the
// critic's verdict is an honest report for the human, not a new
// automated gate.

import path from "path";
import { db } from "./tenant-db";
import { assertCtx } from "./tenant";
import { aiCall } from "./budget";
import { llmVision } from "./llm";
import { parseJsonLoose, videoDir } from "./ai";
import { parseScenes } from "./story";
import { parsePlan, sceneScaleMotionFindings, type SceneScaleMotionFinding } from "./director-plan";
import { verdictFromScore, parseConsistencyReport } from "./visual-consistency";
import { sampleFramesEvenly, VISUAL_SCAN_FRAMES } from "./visual-qc";
import { errorText } from "./redact";
import * as storage from "./storage";
import { log } from "./log";
import type { QcCheck, QcReport } from "./qc";

const criticLog = log.child({ mod: "video-critic" });

export type CriticStatus = "pass" | "hold" | "unmeasured" | "unavailable";
export type CriticDimensionId =
  | "technical"
  | "motion"
  | "audio"
  | "visual"
  | "consistency"
  | "narrative";

export interface CriticDimension {
  id: CriticDimensionId;
  status: CriticStatus;
  /** Which layer produced the row — the deterministic battery, the
   *  stored VCE report, or the critic's own fail-open VLM pass. */
  source: "qc-battery" | "consistency-report" | "critic-vlm";
  evidence: string[]; // check ids / report facts that drove the status
  issues: string[]; // human-readable, capped at 6
}

export interface CriticProposal {
  dimension: CriticDimensionId;
  action: string;
}

export interface CriticReport {
  schema: 1;
  videoId: string;
  checkedAt: string;
  verdict: "ship" | "hold" | "insufficient-evidence";
  dimensions: CriticDimension[];
  proposals: CriticProposal[];
  engine: { ran: boolean; unavailable: string[] };
}

/** Where the persisted report lives (the video's storage namespace,
 *  beside the rendered artifacts). PURE. */
export function criticReportKey(videoId: string): string {
  return `${videoId}/critic-report.json`;
}

/** The battery's checks, classified into critic dimensions. Every check
 *  id the battery emits belongs to EXACTLY one dimension — pinned.
 *  subject-continuity is deliberately NOT here: the consistency row
 *  reads the richer VCE report instead. */
export const DIMENSION_CHECKS: Record<Exclude<CriticDimensionId, "consistency" | "narrative">, string[]> = {
  technical: [
    "playable",
    "aspect",
    "duration",
    "black-frames",
    "captions",
    "restricted-visual",
  ],
  motion: ["frozen-frames", "static-shots", "stutter", "cut-alignment", "flicker"],
  audio: ["dead-air", "loudness", "loudness-range", "true-peak", "tail-fade"],
  visual: ["text-artifacts"],
};

/** The deterministic row for one dimension from the battery's checks —
 *  worst-of mapping: any fail → hold; else any unmeasured → unmeasured;
 *  else pass. No checks → unmeasured (never a silent pass). PURE. */
export function dimensionFromChecks(
  id: CriticDimensionId,
  checks: QcCheck[]
): CriticDimension {
  const wanted = new Set(
    (DIMENSION_CHECKS as Record<string, string[]>)[id] ?? []
  );
  const mine = checks.filter((c) => wanted.has(c.id));
  const base: CriticDimension = {
    id,
    status: "unmeasured",
    source: "qc-battery",
    evidence: mine.map((c) => c.id),
    issues: [],
  };
  if (mine.length === 0) {
    return { ...base, issues: ["the QC battery emitted no checks for this dimension"] };
  }
  const failed = mine.filter((c) => c.status === "fail");
  if (failed.length > 0) {
    return {
      ...base,
      status: "hold",
      issues: failed
        .map((c) => `${c.label}: ${c.value}${c.detail ? ` (${c.detail.slice(0, 80)})` : ""}`)
        .slice(0, 6),
    };
  }
  const unmeasured = mine.filter((c) => c.status === "unmeasured");
  if (unmeasured.length > 0) {
    return {
      ...base,
      status: "unmeasured",
      issues: unmeasured.map((c) => `${c.label} could not be measured`).slice(0, 6),
    };
  }
  return { ...base, status: "pass" }; // everything measured and passed
}

/**
 * S121 P1 — the plan-time scene-scale-motion findings ride the motion
 * dimension's issues: the human reviewer sees the mismatch (an ACTING claim
 * that only moves the frame) without the status being touched by it — the
 * findings are ADVISORY, nothing auto-changes a plan. The 6-issue cap holds.
 * PURE.
 */
export function motionDimensionWithFindings(
  motion: CriticDimension,
  findings: SceneScaleMotionFinding[]
): CriticDimension {
  if (findings.length === 0) return motion;
  return {
    ...motion,
    issues: [
      ...motion.issues,
      ...findings.map((f) => `scene ${f.sceneIndex}: ${f.reason}`),
    ].slice(0, 6),
  };
}

/** The consistency row from the stored VCE report: the WORST checked
 *  scene verdict decides (off/drift → hold); all-unavailable or no
 *  report → unmeasured — never a pass, never a punishment. PURE. */
export function consistencyDimensionFromReport(
  report: ReturnType<typeof parseConsistencyReport>
): CriticDimension {
  const base: CriticDimension = {
    id: "consistency",
    status: "unmeasured",
    source: "consistency-report",
    evidence: [],
    issues: [],
  };
  if (!report) {
    return { ...base, issues: ["no consistency report — run the consistency check first"] };
  }
  const checked = report.scenes.filter(
    (s) => s.verdict === "consistent" || s.verdict === "drift" || s.verdict === "off"
  );
  if (checked.length === 0) {
    return {
      ...base,
      issues: ["the consistency report has no checked scenes (every dimension unavailable)"],
    };
  }
  const worst = checked
    .map((s) => s.verdict)
    .reduce((a, v) => (v === "off" ? "off" : v === "drift" && a !== "off" ? "drift" : a), "consistent");
  const evidence = [`overall ${report.overall}`, `checked ${report.checkedCount} scene(s)`];
  if (worst === "off" || worst === "drift") {
    const flagged = checked.filter((s) => s.verdict === worst).slice(0, 6);
    return {
      ...base,
      status: "hold",
      evidence,
      issues: flagged.map(
        (s) => `scene ${s.sceneIndex}: ${s.issues[0] ?? "inconsistent with the character/plan"}`
      ),
    };
  }
  return { ...base, status: "pass", evidence };
}

/** The critic's own judgement — narrative + visual in ONE call over
 *  frames sampled evenly from the final cut. */
export const CRITIC_SYSTEM = `You are a video critic reviewing the FINAL CUT of a short scripted video. You see frames sampled evenly across the rendered video (in story order) together with the script's scene narrations. Judge TWO dimensions, each on its own:
- narrative: do the frames, in order, communicate the script's story — the depicted moments match the narrated beats, nothing missing, nothing contradictory?
- visual: is the imagery professional and on-topic — relevant subjects, competent composition, no obvious rendering artifacts?
Ignore audio (judged elsewhere), technical file properties (judged elsewhere) and character-identity continuity (judged elsewhere).

Respond with STRICT JSON only: {"narrative":{"score":<0-100>,"issues":["<short human-readable issue>"]},"visual":{"score":<0-100>,"issues":["<short human-readable issue>"]}} — score 100 means the dimension is fully satisfied; list concrete problems (empty arrays when none).`;

/** Parse the critic's reply. A dimension with a missing/non-numeric
 *  score is NULL (never a fabricated 50); scores clamp 0–100 and round;
 *  issues filter to strings, cap 6; >=80 passes, >=55 holds, below
 *  fails. PURE. */
export function parseCriticVerdict(
  text: string
): {
  narrative: { score: number; status: "pass" | "hold"; issues: string[] } | null;
  visual: { score: number; status: "pass" | "hold"; issues: string[] } | null;
} {
  const empty = { narrative: null, visual: null } as {
    narrative: { score: number; status: "pass" | "hold"; issues: string[] } | null;
    visual: { score: number; status: "pass" | "hold"; issues: string[] } | null;
  };
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonLoose(text);
  } catch {
    return empty;
  }
  const one = (v: unknown): { score: number; status: "pass" | "hold"; issues: string[] } | null => {
    if (!v || typeof v !== "object") return null;
    const scoreNum = Number((v as Record<string, unknown>).score);
    if (!Number.isFinite(scoreNum)) return null;
    const score = Math.round(Math.min(100, Math.max(0, scoreNum)));
    const rawIssues = (v as Record<string, unknown>).issues;
    const issues = Array.isArray(rawIssues)
      ? rawIssues.filter((x): x is string => typeof x === "string").slice(0, 6)
      : [];
    return { score, status: verdictFromScore(score) === "consistent" ? "pass" : "hold", issues };
  };
  return {
    narrative: one(parsed.narrative),
    visual: one(parsed.visual),
  };
}

/** The verdict — a REPORT for the human, not an automated gate (the
 *  ship gate stays qc-policy's): any hold → "hold"; nothing measured →
 *  "insufficient-evidence" (honest, never a pass); otherwise "ship"
 *  (unavailable AI layers ride engine.unavailable, they never block).
 *  PURE. */
export function buildCriticVerdict(
  dimensions: CriticDimension[]
): "ship" | "hold" | "insufficient-evidence" {
  if (dimensions.some((d) => d.status === "hold")) return "hold";
  if (!dimensions.some((d) => d.status === "pass")) return "insufficient-evidence";
  return "ship";
}

/** Repair proposals — every hold (and every unmeasured deterministic
 *  dimension) maps to ONE concrete action through the EXISTING
 *  affordances. Propose, never auto-edit. PURE. */
export function buildCriticProposals(
  dimensions: CriticDimension[]
): CriticProposal[] {
  const proposals: CriticProposal[] = [];
  for (const d of dimensions) {
    if (d.status === "pass" || d.status === "unavailable") continue;
    const first = d.issues[0] ?? "";
    if (d.status === "hold") {
      switch (d.id) {
        case "technical":
          proposals.push({ dimension: d.id, action: `Fix the render output before shipping: ${first}` });
          break;
        case "motion":
          proposals.push({ dimension: d.id, action: `Review pacing and motion: ${first} — adjust the Director plan's shot rhythm, then re-render.` });
          break;
        case "audio":
          proposals.push({ dimension: d.id, action: `Rebalance audio: ${first} — re-run the voiceover or adjust the mix, then re-render.` });
          break;
        case "visual":
          proposals.push({ dimension: d.id, action: `Re-paint the offending scene art (Storyboard → scene re-roll): ${first}` });
          break;
        case "consistency":
          proposals.push({ dimension: d.id, action: `Open the Director card — the consistency report names the drifting scenes with one-click fixes: ${first}` });
          break;
        case "narrative":
          proposals.push({ dimension: d.id, action: `Review the sampled frames against the script; regenerate the scenes that miss their beats: ${first}` });
          break;
      }
    } else if (d.status === "unmeasured") {
      proposals.push({
        dimension: d.id,
        action: `Not measured: ${first || "no evidence for this dimension"} — run the QC battery / consistency check, then re-run the critic.`,
      });
    }
  }
  return proposals.slice(0, 8);
}

/** Parse the STORED report (the GET surface). Null for null/corrupt
 *  JSON — never a half-invented envelope. PURE. */
export function parseCriticReport(
  json: string | null | undefined
): CriticReport | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).schema !== 1) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.dimensions)) return null;
  return {
    schema: 1,
    videoId: String(obj.videoId ?? ""),
    checkedAt: typeof obj.checkedAt === "string" ? obj.checkedAt : new Date(0).toISOString(),
    verdict: (["ship", "hold", "insufficient-evidence"] as const).includes(
      obj.verdict as "ship" | "hold" | "insufficient-evidence"
    )
      ? (obj.verdict as "ship" | "hold" | "insufficient-evidence")
      : "insufficient-evidence",
    dimensions: (obj.dimensions as Record<string, unknown>[]).map((d) => ({
      id: String(d.id) as CriticDimensionId,
      status: (d.status ?? "unavailable") as CriticStatus,
      source: (d.source ?? "qc-battery") as CriticDimension["source"],
      evidence: Array.isArray(d.evidence) ? (d.evidence as string[]) : [],
      issues: Array.isArray(d.issues) ? (d.issues as string[]) : [],
    })),
    proposals: Array.isArray(obj.proposals)
      ? (obj.proposals as Record<string, unknown>[]).map((p) => ({
          dimension: String(p.dimension) as CriticDimensionId,
          action: String(p.action ?? ""),
        }))
      : [],
    engine: {
      ran: Boolean((obj.engine as Record<string, unknown> | undefined)?.ran),
      unavailable: Array.isArray((obj.engine as Record<string, unknown> | undefined)?.unavailable)
        ? ((obj.engine as Record<string, unknown>).unavailable as string[])
        : [],
    },
  };
}

/** Run the critic for one video. Job body — runs under ctx (kind
 *  "critic"). Deterministic rows from the stored QC report + VCE
 *  report; ONE fail-open VLM call for narrative+visual over frames
 *  sampled from final.mp4. Manual-only by design. */
export async function runVideoCritic(videoId: string): Promise<CriticReport> {
  const ctx = assertCtx("runVideoCritic");
  const video = await db.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      organizationId: true,
      scenes: true,
      consistency: true,
      qcReport: true,
      shotList: true,
    },
  });
  if (!video) throw new Error("Video not found");
  const unavailable: string[] = [];
  const dimensions: CriticDimension[] = [];

  // 1. The deterministic rows — from the stored QC battery report.
  let qc: QcReport | null = null;
  try {
    const parsed = video.qcReport ? (JSON.parse(video.qcReport) as QcReport) : null;
    qc = parsed && Array.isArray(parsed.checks) ? parsed : null;
  } catch {
    qc = null;
  }
  const checks: QcCheck[] = qc?.checks ?? [];
  if (!qc) unavailable.push("qc: no stored QC report — run the QC battery first");
  for (const id of ["technical", "motion", "audio"] as const) {
    let dimension = dimensionFromChecks(id, checks);
    // S121 P1 — the plan's scene-scale-motion findings ride the motion row.
    if (id === "motion" && video.shotList) {
      const plan = parsePlan(video.shotList);
      if (plan) {
        const findings = plan.scenes.flatMap((s) => sceneScaleMotionFindings(s));
        dimension = motionDimensionWithFindings(dimension, findings);
      }
    }
    dimensions.push(dimension);
  }

  // 2. The consistency row — from the stored VCE report.
  dimensions.push(consistencyDimensionFromReport(parseConsistencyReport(video.consistency)));

  // 3. The critic's own layer — narrative + visual over sampled frames.
  const scenes = parseScenes(video.scenes);
  const mp4Path = path.join(videoDir(videoId), "final.mp4");
  const durationSec = qc?.durationSec ?? 0;
  let ranVlm = false;
  let visualVlm: { score: number; status: "pass" | "hold"; issues: string[] } | null = null;
  let narrativeVlm: { score: number; status: "pass" | "hold"; issues: string[] } | null = null;
  const frames = await sampleFramesEvenly(mp4Path, durationSec, VISUAL_SCAN_FRAMES);
  if (frames.length === 0) {
    unavailable.push("critic: no frames could be sampled from final.mp4 — narrative and visual not judged");
  } else {
    const userParts: unknown[] = [
      {
        type: "text",
        text:
          `Frames sampled evenly across the final cut, in story order (${frames.length} frames):`,
      },
    ];
    for (let i = 0; i < frames.length; i++) {
      userParts.push({ type: "text", text: `Frame ${i + 1} of ${frames.length}:` });
      userParts.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${frames[i]}` },
      });
    }
    const beats = scenes
      .map((s) => `Scene ${s.index}: ${s.narration.slice(0, 160)}`)
      .slice(0, 12)
      .join("\n");
    userParts.push({ type: "text", text: `The script's scene narrations, in order:\n${beats}` });
    try {
      const raw = await aiCall("llm", "critic VLM", () =>
        llmVision({
          messages: [
            { role: "system", content: CRITIC_SYSTEM },
            { role: "user", content: userParts },
          ],
          temperature: 0.1,
        })
      );
      ranVlm = true;
      const parsed = parseCriticVerdict(raw.choices?.[0]?.message?.content ?? "");
      narrativeVlm = parsed.narrative;
      visualVlm = parsed.visual;
    } catch (err) {
      unavailable.push(`critic: VLM call failed: ${errorText(err, "vision error").slice(0, 120)}`);
      criticLog.warn("critic VLM call failed — narrative/visual unavailable", {
        videoId,
        err: errorText(err, "vision error"),
      });
    }
  }

  // The visual dimension: worst-of the deterministic text-artifacts row
  // and the VLM's visual judgement — AI never replaces the deterministic
  // check, and the deterministic check never hides the VLM's finding.
  const visualDet = dimensionFromChecks("visual", checks);
  if (visualVlm) {
    const status: CriticStatus =
      visualDet.status === "hold" || visualVlm.status === "hold"
        ? "hold"
        : visualDet.status === "pass" || visualVlm.status === "pass"
          ? "pass"
          : "unmeasured";
    dimensions.push({
      id: "visual",
      status,
      source: "critic-vlm",
      evidence: [...visualDet.evidence, `vlm score ${visualVlm.score}`],
      issues: [...visualVlm.issues, ...visualDet.issues].slice(0, 6),
    });
  } else {
    dimensions.push(visualDet);
  }

  // The narrative dimension — the critic's own judgement alone.
  if (narrativeVlm) {
    dimensions.push({
      id: "narrative",
      status: narrativeVlm.status,
      source: "critic-vlm",
      evidence: [`vlm score ${narrativeVlm.score}`],
      issues: narrativeVlm.issues,
    });
  } else if (frames.length > 0) {
    dimensions.push({
      id: "narrative",
      status: "unavailable",
      source: "critic-vlm",
      evidence: [],
      issues: ["the narrative judgement is unavailable — the VLM reply had no verdict"],
    });
  } else {
    dimensions.push({
      id: "narrative",
      status: "unmeasured",
      source: "critic-vlm",
      evidence: [],
      issues: ["no frames sampled — final.mp4 missing or unreadable"],
    });
  }

  const report: CriticReport = {
    schema: 1,
    videoId,
    checkedAt: new Date().toISOString(),
    verdict: buildCriticVerdict(dimensions),
    dimensions,
    proposals: buildCriticProposals(dimensions),
    engine: { ran: ranVlm, unavailable },
  };
  await storage.put(criticReportKey(videoId), Buffer.from(JSON.stringify(report)));
  await db.activity.create({
    data: {
      organizationId: video.organizationId,
      userId: ctx.userId,
      videoId,
      stage: "qc",
      message: `Video critic: ${report.verdict} — ${dimensions
        .map((d) => `${d.id} ${d.status}`)
        .join(", ")}`,
    },
  });
  return report;
}
