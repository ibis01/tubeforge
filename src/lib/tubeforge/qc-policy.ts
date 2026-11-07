// S40 — the QC ship gate: which findings block export/publish, which only warn.
//
// Doctrine shift (the audit's "QC enforcement policy" item): through S39 the
// battery's report was ADVISORY — "the render never fails because of QC; the
// report drives the badge so a human can inspect before export/upload". The
// human-inspect step was the only gate, and nothing enforced it. S40 keeps the
// measurement doctrine untouched (QC still never fails a render — measurement
// and enforcement are separate acts) but makes the SHIP deliberate:
//
//   BLOCK  — the file is broken, misrepresents the script, or carries
//            visible/audible structural damage. Nine checks: playable,
//            duration, black-frames, frozen-frames, aspect, dead-air,
//            flicker, stutter, cut-alignment.
//   REPORT — polish and editorial judgment the operator decides on. Six:
//            loudness, true-peak, loudness-range, tail-fade, static-shots,
//            captions.
//
// Fail-closed rules (each pinned by unit tests / the S40 probe):
//   1. An UNMEASURED blocking check blocks. A lens that never ran cannot
//      certify the file — the battery's own "never read as clean" law.
//   2. A report with ZERO checks blocks (missingReport) — the battery always
//      emits at least one; an empty report means something ate it.
//   3. An UNKNOWN check id (a future battery's new lens, missing from the
//      matrix) blocks until it is classified here. New checks must be given a
//      severity deliberately, never inherit "advisory" by silence.
//   4. No standing report on a rendered video blocks (fail-closed; the fix is
//      one "Re-run QC" click).
//   5. Junk TUBEFORGE_QC_ENFORCEMENT values fall back to enforce.
//
// The human escape hatch is the OVERRIDE: a stamped, noted acceptance of
// exactly ONE report's findings (POST /api/videos/[id]/export with a note).
// A re-render or QC re-run writes a new report → different checkedAt → the
// override is stale and the gate holds again. New evidence always supersedes
// a human's acceptance of old evidence.
//
// Scope: the gate sits on the two SHIP surfaces — the export bundle (GET
// /api/videos/[id]/export) and the YouTube upload (POST /publish). The raw
// final.mp4 download and in-app preview stay open: inspecting a flagged file
// is how a human decides.

import type { QcCheckDTO, QcReportDTO, QcStatusDTO } from "./types";

export type QcSeverity = "block" | "report";

/** One matrix row — the severity plus the one-line rationale the UI shows
 * next to every finding (a policy nobody can read is a policy nobody
 * trusts). */
export interface QcPolicyEntry {
  severity: QcSeverity;
  why: string;
}

/** Bumped whenever a severity flips or a check is added — stamped into every
 * gate decision so a stored decision can name the policy that made it. */
export const QC_POLICY_VERSION = "s53-v1";

/**
 * The enforcement matrix. Every check id qc.ts can emit is classified
 * exactly once (unit-pinned against the battery's emission set). Rationales
 * cite the calibration history that motivated each check.
 */
export const QC_ENFORCEMENT_MATRIX: Record<string, QcPolicyEntry> = {
  playable: {
    severity: "block",
    why: "no H.264+AAC stream is not a video — nothing downstream can repair it",
  },
  duration: {
    severity: "block",
    why: "a video meaningfully shorter than its narration cut words mid-sentence (the −34 s class)",
  },
  "black-frames": {
    severity: "block",
    why: "unexplained black intervals are a broken stitch, not an edit",
  },
  "frozen-frames": {
    severity: "block",
    why: "seconds-long freezes are hold-last-frame artifacts and dead pans (the 2.3 s class)",
  },
  aspect: {
    severity: "block",
    why: "wrong frame geometry is a squeeze/crop defect — the file misrepresents its format",
  },
  "dead-air": {
    severity: "block",
    why: "1.5 s+ of total silence breaks the voice-or-bed contract",
  },
  flicker: {
    severity: "block",
    why: "strobe-level luminance pumping is visible damage (the broken i2v blend class)",
  },
  stutter: {
    severity: "block",
    why: "duplicated presentation frames and timestamp gaps read as judder",
  },
  "cut-alignment": {
    severity: "block",
    why: "stray cuts (broken stitch) or missing cuts (swallowed seam) break the timeline contract",
  },
  loudness: {
    severity: "report",
    why: "YouTube normalizes playback loudness — off-target LUFS is polish, not damage",
  },
  "true-peak": {
    severity: "report",
    why: "residual peak misses are marginal clipping — the 0.2 dB tolerance already covers encode overshoot",
  },
  "loudness-range": {
    severity: "report",
    why: "level consistency advisory (pumping levels), not shippability",
  },
  "tail-fade": {
    severity: "report",
    why: "an abrupt ending reads as a glitch but is an editorial choice",
  },
  "static-shots": {
    severity: "report",
    why: "pacing is editorial — the approved plan may deliberately hold shots still",
  },
  captions: {
    severity: "report",
    why: "the SRT is a sidecar — a broken track never damages the video and re-exports without a render",
  },
  "restricted-visual": {
    severity: "block",
    why: "a depicted restricted religious figure violates the video's declared content policy — the artifact misrepresents what the production promised (S49; emitted only under a restricted policy, fail-closed on unmeasured)",
  },
  "subject-continuity": {
    severity: "report",
    why: "identity drift of the recurring subject is a continuity defect the operator repaints or accepts — lighting-induced hue shift is noted, never failed (S53; the S51 benchmark's finding class)",
  },
  "text-artifacts": {
    severity: "report",
    why: "gibberish pseudo-text and watermarks are polish defects of AI imagery — deliberate burned captions are excluded by the judge; REPORT until calibration evidence justifies a flip (S53)",
  },
};

/** Number of blocking checks — pinned by tests so a matrix edit that flips
 * the balance is a visible, deliberate act. */
export const QC_BLOCKING_COUNT = Object.values(QC_ENFORCEMENT_MATRIX).filter(
  (e) => e.severity === "block"
).length;

// ---------------------------------------------------------------------------
// Enforcement mode (env switch — the pre-S40 behavior stays one setting away)
// ---------------------------------------------------------------------------

export type QcEnforcementMode = "enforce" | "report";

/**
 * Read TUBEFORGE_QC_ENFORCEMENT. "report" (exact, case-sensitive) turns the
 * gate advisory — the S33-era behavior. UNSET, empty or junk values fail
 * CLOSED to enforce: an operator who typos the switch keeps the protection.
 */
export function qcEnforcementMode(
  env: NodeJS.ProcessEnv | { TUBEFORGE_QC_ENFORCEMENT?: string | undefined } = process.env
): QcEnforcementMode {
  return env.TUBEFORGE_QC_ENFORCEMENT === "report" ? "report" : "enforce";
}

// ---------------------------------------------------------------------------
// The gate decision
// ---------------------------------------------------------------------------

/** A non-passing check through the policy lens (passes never appear). */
export interface QcPolicyFinding {
  id: string;
  label: string;
  status: QcStatusDTO;
  value: string;
  detail?: string;
  severity: QcSeverity;
  why: string;
}

export interface QcGateDecision {
  mode: QcEnforcementMode;
  policyVersion: string;
  /** The decision: export/publish must refuse when true. */
  blocked: boolean;
  /** Findings that would block under enforcement (populated even in report
   * mode — the UI shows them as "would hold"). */
  blockers: QcPolicyFinding[];
  /** Non-blocking findings worth showing. */
  advisories: QcPolicyFinding[];
  /** No report (or an empty one) stands behind this decision. */
  missingReport: boolean;
}

/** Structural shape so both the battery's QcReport and the wire QcReportDTO
 * feed the same pure decision. */
export interface QcReportLike {
  checks: (QcCheckDTO | { id: string; label: string; status: QcStatusDTO; value: string; detail?: string })[];
  /** S45 — evidence scope. "preview" = the standing report measured a
   * first-N-scenes preview render, not final.mp4: it can never certify the
   * artifact the export gate is about to ship. Absent = full render. */
  scope?: string;
}

/**
 * Apply the policy to a standing report. Pure — no env reads, no clock: the
 * caller passes the mode (routes read env once at decision time; tests pin
 * every branch). `null` report = nothing stands behind the file.
 */
export function applyQcPolicy(
  report: QcReportLike | null,
  opts: { mode?: QcEnforcementMode } = {}
): QcGateDecision {
  const mode = opts.mode ?? "enforce";
  const blockers: QcPolicyFinding[] = [];
  const advisories: QcPolicyFinding[] = [];
  // Fail-closed #2/#4: no report, or a report the battery never populated,
  // is an unmeasured file — not a clean one. S45: a preview-scoped report
  // is equally NOT evidence for the final artifact — the write site only
  // persists it while no full render stands, but the policy refuses to
  // trust it even if a future writer violates that invariant (fail-closed
  // #5: partial evidence never certifies the whole).
  const missingReport =
    report === null ||
    !Array.isArray(report.checks) ||
    report.checks.length === 0 ||
    report.scope === "preview";
  if (!missingReport) {
    for (const c of report.checks) {
      if (c.status === "pass") continue;
      const entry = QC_ENFORCEMENT_MATRIX[c.id];
      const finding: QcPolicyFinding = {
        id: c.id,
        label: c.label,
        status: c.status,
        value: c.value,
        ...(c.detail !== undefined && c.detail !== null ? { detail: c.detail } : {}),
        // Fail-closed #3: unknown ids block until classified in the matrix.
        severity: entry ? entry.severity : "block",
        why: entry
          ? entry.why
          : "not in the S40 policy matrix — classify this check in qc-policy.ts",
      };
      (finding.severity === "block" ? blockers : advisories).push(finding);
    }
  }
  return {
    mode,
    policyVersion: QC_POLICY_VERSION,
    blocked: mode === "enforce" && (missingReport || blockers.length > 0),
    blockers,
    advisories,
    missingReport,
  };
}

// ---------------------------------------------------------------------------
// The override — a human accepted EXACTLY this report's findings
// ---------------------------------------------------------------------------

/** Row shape (Prisma Video or a test fixture). */
export interface QcOverrideLike {
  qcOverrideAt: Date | string | null;
  qcOverrideNote: string | null;
  /** The checkedAt of the report the human accepted — staleness anchor. */
  qcOverrideForCheckedAt: string | null;
}

/**
 * Is the override still standing? Valid iff an override was stamped AND a
 * report stands AND the override was accepted for EXACTLY that report. Any
 * new report (re-render, QC re-run) changes checkedAt → stale → the gate
 * holds again. String compare is exact by design: ISO timestamps from the
 * same writer (new Date().toISOString()) are stable.
 */
export function qcOverrideValid(
  override: QcOverrideLike | null | undefined,
  report: QcReportLike | null
): boolean {
  if (!override || !override.qcOverrideAt || !override.qcOverrideNote) return false;
  if (!report || !Array.isArray(report.checks) || report.checks.length === 0) return false;
  const anchor = (report as { checkedAt?: unknown }).checkedAt;
  return (
    typeof anchor === "string" &&
    anchor.length > 0 &&
    override.qcOverrideForCheckedAt === anchor
  );
}

// ---------------------------------------------------------------------------
// Report parsing (one source of truth for routes + serialization)
// ---------------------------------------------------------------------------

/**
 * Parse a stored qcReport JSON. Tolerant of anything: null, garbage, legacy
 * shapes → null (which the gate treats as missingReport — fail-closed, the
 * malformed-report case can never read as clean).
 */
export function parseQcReport(raw: string | null | undefined): QcReportDTO | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as QcReportDTO;
    return parsed && typeof parsed.passed === "boolean" && Array.isArray(parsed.checks) ? parsed : null;
  } catch {
    return null;
  }
}
