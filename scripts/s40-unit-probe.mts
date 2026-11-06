#!/usr/bin/env node
/**
 * S40 probe — QC enforcement policy, the property space the unit tests sample.
 *
 *   node --import tsx scripts/s40-unit-probe.mts
 *
 * Pure — no DB, no ffmpeg, no AI, no network. Safe to run anywhere.
 *
 * What it proves beyond test-unit.mts:
 *   1. the partition, exhaustively — EVERY check id failing alone (and
 *      unmeasured alone) blocks exactly when its matrix severity says block;
 *      the unit suite samples three ids, this walks all fifteen;
 *   2. the maximal cases — all six report-severity findings at once never
 *      hold the ship; all nine blocking findings at once hold with nine
 *      named blockers;
 *   3. the override staleness matrix — the anchor is string-exact, a Date
 *      stamp is as good as a string stamp, and nothing but the matching
 *      report+note pair unlocks;
 *   4. the env switch — injected env objects (no process mutation), the
 *      exact-match rule, and fail-closed on everything unrecognized;
 *   5. parseQcReport tolerance edges — boolean-vs-number `passed`, detail
 *      fidelity through findings, and the empty-checks fail-closed handoff.
 */

import {
  applyQcPolicy,
  parseQcReport,
  qcEnforcementMode,
  qcOverrideValid,
  QC_BLOCKING_COUNT,
  QC_ENFORCEMENT_MATRIX,
  QC_POLICY_VERSION,
  type QcReportLike,
} from "../src/lib/tubeforge/qc-policy";

let passed = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
function eq<T>(actual: T, expected: T, label = "value"): void {
  ok(Object.is(actual, expected), `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const ALL_IDS = Object.keys(QC_ENFORCEMENT_MATRIX);
const BLOCK_IDS = ALL_IDS.filter((id) => QC_ENFORCEMENT_MATRIX[id].severity === "block");
const REPORT_IDS = ALL_IDS.filter((id) => QC_ENFORCEMENT_MATRIX[id].severity === "report");

const check = (id: string, status: "pass" | "fail" | "unmeasured", detail?: string) => ({
  id,
  label: `probe ${id}`,
  status,
  value: `${status}-fixture`,
  pass: status === "pass",
  ...(detail !== undefined ? { detail } : {}),
});
const report = (
  checks: ReturnType<typeof check>[],
  checkedAt = "2026-11-06T00:00:00.000Z"
): QcReportLike & { checkedAt: string } => ({
  passed: checks.every((c) => c.status === "pass"),
  checkedAt,
  durationSec: 60,
  checks,
});
const alone = (id: string, status: "fail" | "unmeasured") =>
  report(ALL_IDS.map((x) => check(x, x === id ? status : "pass")));

console.log("S40 probe — the enforcement matrix");

// A. The partition, spelled independently: what the owner's audit language
//    says must hold the ship vs what it leaves to judgment.
{
  const EXPECTED_BLOCK = [
    "playable", "duration", "black-frames", "frozen-frames", "aspect",
    "dead-air", "flicker", "stutter", "cut-alignment",
  ].sort();
  const EXPECTED_REPORT = [
    "loudness", "true-peak", "loudness-range", "tail-fade", "static-shots",
    "captions",
  ].sort();
  eq([...BLOCK_IDS].sort().join(","), EXPECTED_BLOCK.join(","), "the nine blocking ids (independent spelling)");
  eq([...REPORT_IDS].sort().join(","), EXPECTED_REPORT.join(","), "the six report ids (independent spelling)");
  eq(QC_BLOCKING_COUNT, 9, "blocking count constant");
  ok(ALL_IDS.length === 15, `fif checks classified (got ${ALL_IDS.length})`);
  for (const id of ALL_IDS) {
    ok(QC_ENFORCEMENT_MATRIX[id].why.length > 10, `${id}: rationale present`);
  }
  eq(QC_POLICY_VERSION, "s40-v1", "policy version");
}

console.log("S40 probe — exhaustive per-id partition");

// B. EVERY id failing alone blocks iff its severity is block. The unit suite
//    samples loudness/flicker/stutter; this walks the whole space, so a
//    severity flip anywhere changes a probe assertion (visible, deliberate).
{
  let failBlocked = 0;
  let failAdvisory = 0;
  for (const id of ALL_IDS) {
    const d = applyQcPolicy(alone(id, "fail"));
    const shouldBlock = QC_ENFORCEMENT_MATRIX[id].severity === "block";
    if (shouldBlock) {
      failBlocked++;
      ok(d.blocked && d.blockers.length === 1 && d.blockers[0].id === id,
        `${id} failing alone → one blocking finding`);
      eq(d.advisories.length, 0, `${id} failing alone → no advisories`);
    } else {
      failAdvisory++;
      ok(!d.blocked && d.advisories.length === 1 && d.advisories[0].id === id,
        `${id} failing alone → one advisory, no hold`);
      eq(d.blockers.length, 0, `${id} failing alone → no blockers`);
    }
  }
  eq(failBlocked, 9, "nine ids block on a lone fail");
  eq(failAdvisory, 6, "six ids advise on a lone fail");

  // Same walk with UNMEASURED — the three-state law: a lens that never ran
  // cannot certify, so unmeasured inherits the severity verdict exactly.
  for (const id of ALL_IDS) {
    const d = applyQcPolicy(alone(id, "unmeasured"));
    eq(
      d.blocked,
      QC_ENFORCEMENT_MATRIX[id].severity === "block",
      `${id} unmeasured alone → blocked iff blocking severity`
    );
  }
}

console.log("S40 probe — maximal cases");

// C. The extremes: every advisory failing at once still ships; every blocker
//    failing at once names all nine.
{
  const allPolish = applyQcPolicy(report(REPORT_IDS.map((id) => check(id, "fail"))));
  ok(!allPolish.blocked, "all six report-severity findings → ship is NOT held");
  eq(allPolish.advisories.length, 6, "six advisories named");

  const allBlock = applyQcPolicy(report(BLOCK_IDS.map((id) => check(id, "fail"))));
  ok(allBlock.blocked, "all nine blocking findings → hold");
  eq(allBlock.blockers.length, 9, "nine blockers named");
  eq(
    allBlock.blockers.filter((b) => b.severity === "block").length,
    9,
    "every blocker carries blocking severity"
  );

  // Mixed: one of each — blocked with the blocker, advisory kept visible.
  const mixed = applyQcPolicy(report([
    ...BLOCK_IDS.slice(0, 2).map((id) => check(id, "fail")),
    ...REPORT_IDS.slice(0, 3).map((id) => check(id, "unmeasured")),
  ]));
  ok(mixed.blocked, "mixed report → held by its blocking findings");
  eq(mixed.blockers.length, 2, "two blockers");
  eq(mixed.advisories.length, 3, "three advisories survive alongside the hold");
}

console.log("S40 probe — override staleness matrix");

// D. The anchor law: string-exact checkedAt, note required, report required.
{
  const r = report([check("flicker", "fail")], "2026-11-06T12:00:00.000Z");
  const stamp = (forCheckedAt: string | null, note: string | null, at: Date | string | null = new Date()) =>
    ({ qcOverrideAt: at, qcOverrideNote: note, qcOverrideForCheckedAt: forCheckedAt });

  eq(qcOverrideValid(stamp("2026-11-06T12:00:00.000Z", "deadline"), r), true, "exact anchor + note → valid");
  eq(qcOverrideValid(stamp("2026-11-06T12:00:00.000Z", "deadline", "2026-11-06T12:30:00.000Z"), r), true, "string stamp as valid as a Date");
  eq(qcOverrideValid(stamp("2026-11-06T12:00:00.000Z ", "deadline"), r), false, "trailing space in anchor → stale (string-exact)");
  eq(qcOverrideValid(stamp("", "deadline"), r), false, "empty anchor → stale");
  eq(qcOverrideValid(stamp("2026-11-06T12:00:00.000Z", ""), r), false, "empty note → not an acceptance");
  eq(qcOverrideValid(stamp(null, "deadline"), r), false, "null anchor → stale");
  eq(qcOverrideValid(undefined, r), false, "no override object → stale");
  eq(qcOverrideValid(stamp("2026-11-06T12:00:00.000Z", "deadline"), null), false, "no standing report → stale");
  // Zero-checks "report" is missing by policy — an override for it cannot stand.
  eq(qcOverrideValid(stamp("t", "deadline"), report([])), false, "empty report → nothing to accept");
}

console.log("S40 probe — the env switch (injected, fail-closed)");

// E. qcEnforcementMode reads an injected env — no process.env mutation here.
{
  eq(qcEnforcementMode({ TUBEFORGE_QC_ENFORCEMENT: "report" }), "report", "exact 'report'");
  eq(qcEnforcementMode({ TUBEFORGE_QC_ENFORCEMENT: "enforce" }), "enforce", "explicit 'enforce'");
  eq(qcEnforcementMode({}), "enforce", "absent → enforce");
  eq(qcEnforcementMode({ TUBEFORGE_QC_ENFORCEMENT: "" }), "enforce", "empty → enforce");
  eq(qcEnforcementMode({ TUBEFORGE_QC_ENFORCEMENT: "report " }), "enforce", "trailing space is junk → enforce");
  eq(qcEnforcementMode({ TUBEFORGE_QC_ENFORCEMENT: "Report" }), "enforce", "case-sensitive → enforce");

  // The mode gates the DECISION, not the findings: report mode keeps the
  // would-block list for the UI's "advisory" badge.
  const d = applyQcPolicy(alone("stutter", "fail"), { mode: "report" });
  eq(d.mode, "report", "decision echoes the mode");
  eq(d.blocked, false, "report mode: no hold");
  eq(d.blockers.length, 1, "report mode: the finding stays visible");
  eq(applyQcPolicy(null, { mode: "report" }).blocked, false, "report mode releases even a missing report");
  eq(applyQcPolicy(null, { mode: "enforce" }).missingReport, true, "enforce mode: missing report flagged");
  eq(applyQcPolicy(alone("playable", "pass")).policyVersion, QC_POLICY_VERSION, "decision stamps the policy version");
}

console.log("S40 probe — parseQcReport tolerance edges");

// F. The parser is the single source of report truth (serialize + routes).
{
  ok(parseQcReport(JSON.stringify(report([check("playable", "pass")]))) !== null, "valid report parses");
  eq(parseQcReport('{"passed":1,"checkedAt":"t","durationSec":1,"checks":[]}'), null, "number `passed` → null (must be boolean)");
  eq(parseQcReport('{"passed":true,"checkedAt":"t","durationSec":1,"checks":[{"id":"x"}]}')?.checks.length ?? 0, 1,
    "checks entries pass through unvalidated (the policy's unknown-id rule handles them)");
  const parsed = parseQcReport(JSON.stringify(report([check("flicker", "fail", "from 12.3s (9 swings)")], "T1")));
  ok(parsed !== null && parsed.checkedAt === "T1", "checkedAt survives the round trip");

  // Detail fidelity through findings — present when given, absent otherwise.
  const withDetail = applyQcPolicy(report([check("flicker", "fail", "pumping 2.5 Hz")]));
  eq(withDetail.blockers[0].detail, "pumping 2.5 Hz", "blocker carries the check's detail");
  const withoutDetail = applyQcPolicy(report([check("flicker", "fail")]));
  eq(withoutDetail.blockers[0].detail, undefined, "no detail when the check had none");
}

// ---------- summary ----------

console.log(`\n${"─".repeat(56)}`);
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`${passed} passed — S40 probe clean`);
